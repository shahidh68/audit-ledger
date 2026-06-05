/**
 * Processor Lambda — drains SQS and writes each audit event to:
 *   1. DynamoDB  — queryable index (list by tenant, look up by event_id)
 *   2. S3        — immutable WORM archive (Object Lock COMPLIANCE mode)
 *
 * Tamper evidence: the S3 copy cannot be modified or deleted for the retention
 * period. If the DynamoDB record ever differs from the S3 original, tampering
 * is detectable.
 *
 * Completeness evidence: each successfully stored record receives a per-tenant
 * monotonic sequence_no. The verify-completeness endpoint compares the
 * tenant's counter against the rows present in DynamoDB to surface deletions
 * or omissions that would otherwise be invisible (a deleted Dynamo row leaves
 * no gap on its own; a missing sequence number does).
 */
import type { SQSEvent } from 'aws-lambda';
import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { parseEnvInt, RETENTION_YEARS_DEFAULT } from './lib/config';
import { allocateNextSequence } from './lib/sequenceAllocator';

const dynamo = new DynamoDBClient({});
const s3     = new S3Client({});

// Parsed once at module load — env vars are set before the first invocation.
const retentionYears = parseEnvInt('RETENTION_YEARS', RETENTION_YEARS_DEFAULT);

interface ProcessorEnv {
  tableName:         string;
  bucketName:        string;
  sequenceTableName: string;
}

function readEnv(): ProcessorEnv {
  const tableName         = process.env.AUDIT_TABLE;
  const bucketName        = process.env.AUDIT_BUCKET;
  const sequenceTableName = process.env.TENANT_SEQUENCE_TABLE;
  if (!tableName || !bucketName || !sequenceTableName) {
    throw new Error(
      'Missing required env vars: AUDIT_TABLE, AUDIT_BUCKET, TENANT_SEQUENCE_TABLE',
    );
  }
  return { tableName, bucketName, sequenceTableName };
}

export async function handler(event: SQSEvent): Promise<void> {
  const env = readEnv();
  for (const record of event.Records) {
    const body = JSON.parse(record.body) as Record<string, unknown>;
    // _ingested_at is a pipeline-internal field — strip before storing.
    delete body._ingested_at;
    await processOne(body, env);
  }
}

// ── per-event processing ─────────────────────────────────────────────────────

async function processOne(
  body: Record<string, unknown>,
  env: ProcessorEnv,
): Promise<void> {
  const tenantId  = String(body.tenant_id ?? '');
  const eventId   = String(body.event_id  ?? '');
  const timestamp = String(body.timestamp ?? new Date().toISOString());

  // Sort key combines timestamp + event_id so records sort chronologically
  // within a tenant and are still uniquely addressable.
  const sk = `${timestamp}#${eventId}`;

  // ── 1. Idempotency pre-check via event_id-index ────────────────────────────
  // SQS may redeliver the same message; without this check we would burn a
  // sequence number on every retry of an already-stored event. The Query is
  // strongly-consistent-equivalent for our access pattern because the GSI
  // is populated synchronously with the base item.
  const existing = await findExistingByEventId(env.tableName, eventId);
  if (existing && typeof existing.sequence_no === 'number') {
    // Already processed and stamped. Nothing to do.
    return;
  }

  // ── 2. Allocate sequence number atomically ─────────────────────────────────
  const sequenceNo = await allocateNextSequence(env.sequenceTableName, tenantId);
  const stamped    = { ...body, sk, sequence_no: sequenceNo };

  // ── 3. Write to DynamoDB ───────────────────────────────────────────────────
  // ConditionExpression prevents accidental overwrites. On true race during
  // SQS redelivery (rare), the put fails and we log a "burned sequence"
  // observation so operators can distinguish from real deletions.
  let dynamoWritten = false;
  try {
    await dynamo.send(new PutItemCommand({
      TableName: env.tableName,
      Item: marshall(stamped, { removeUndefinedValues: true }),
      ConditionExpression: 'attribute_not_exists(sk)',
    }));
    dynamoWritten = true;
  } catch (e: unknown) {
    if (e instanceof ConditionalCheckFailedException) {
      // Concurrent SQS redelivery wrote first. The sequence number we just
      // allocated will never be used. Surface via a structured log line so
      // a CloudWatch metric filter can count it.
      console.warn(JSON.stringify({
        event:        'sequence_burned',
        tenant_id:    tenantId,
        event_id:     eventId,
        burned_seq:   sequenceNo,
        reason:       'concurrent_write_race',
      }));
      return;
    }
    throw e;
  }

  // ── 4. Write to S3 with Object Lock (WORM) ────────────────────────────────
  // COMPLIANCE mode: cannot be deleted or overwritten, even by the account
  // root, until the retention date. Include sequence_no in the archived body
  // so a Dynamo restore from S3 preserves the original ordering.
  if (!dynamoWritten) return;
  const retainUntil = new Date();
  retainUntil.setFullYear(retainUntil.getFullYear() + retentionYears);

  await s3.send(new PutObjectCommand({
    Bucket:                    env.bucketName,
    Key:                       `${tenantId}/${eventId}.json`,
    Body:                      JSON.stringify({ ...body, sequence_no: sequenceNo }),
    ContentType:               'application/json',
    ObjectLockMode:            'COMPLIANCE',
    ObjectLockRetainUntilDate: retainUntil,
  }));
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function findExistingByEventId(
  tableName: string,
  eventId: string,
): Promise<Record<string, unknown> | null> {
  const result = await dynamo.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'event_id-index',
    KeyConditionExpression: 'event_id = :eid',
    ExpressionAttributeValues: { ':eid': { S: eventId } },
    Limit: 1,
  }));
  return result.Items?.length ? unmarshall(result.Items[0]) : null;
}
