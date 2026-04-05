/**
 * Processor Lambda — drains SQS and writes each audit event to:
 *   1. DynamoDB  — queryable index (list by tenant, look up by event_id)
 *   2. S3        — immutable WORM archive (Object Lock COMPLIANCE mode)
 *
 * Tamper evidence: the S3 copy cannot be modified or deleted for the retention
 * period. If the DynamoDB record ever differs from the S3 original, tampering
 * is detectable. This replaces QLDB (discontinued July 2025).
 */
import type { SQSEvent } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { marshall } from '@aws-sdk/util-dynamodb';

const dynamo = new DynamoDBClient({});
const s3     = new S3Client({});

export async function handler(event: SQSEvent): Promise<void> {
  const tableName     = process.env.AUDIT_TABLE;
  const bucketName    = process.env.AUDIT_BUCKET;
  const retentionYears = parseInt(process.env.RETENTION_YEARS ?? '7', 10);

  if (!tableName || !bucketName) {
    throw new Error('AUDIT_TABLE or AUDIT_BUCKET not set');
  }

  for (const record of event.Records) {
    const body = JSON.parse(record.body) as Record<string, unknown>;

    // _ingested_at is a pipeline-internal field — strip before storing
    delete body._ingested_at;

    const tenantId  = String(body.tenant_id ?? '');
    const eventId   = String(body.event_id  ?? '');
    const timestamp = String(body.timestamp ?? new Date().toISOString());

    // Sort key combines timestamp + event_id so records sort chronologically
    // within a tenant and are still uniquely addressable.
    const sk = `${timestamp}#${eventId}`;

    // ── 1. Write to DynamoDB ─────────────────────────────────────────────────
    // ConditionExpression prevents accidental overwrites (idempotency on retry).
    try {
      await dynamo.send(new PutItemCommand({
        TableName: tableName,
        Item: marshall({ ...body, sk }, { removeUndefinedValues: true }),
        ConditionExpression: 'attribute_not_exists(sk)',
      }));
    } catch (e: unknown) {
      // ConditionalCheckFailedException = already written (SQS retry) — safe to skip
      const name = e instanceof Error ? (e as { name?: string }).name : '';
      if (name !== 'ConditionalCheckFailedException') throw e;
    }

    // ── 2. Write to S3 with Object Lock (WORM) ───────────────────────────────
    // COMPLIANCE mode: cannot be deleted or overwritten, even by the account root,
    // until the retention date. This is the legally defensible tamper-evidence layer.
    const retainUntil = new Date();
    retainUntil.setFullYear(retainUntil.getFullYear() + retentionYears);

    await s3.send(new PutObjectCommand({
      Bucket:                    bucketName,
      Key:                       `${tenantId}/${eventId}.json`,
      Body:                      JSON.stringify(body),
      ContentType:               'application/json',
      ObjectLockMode:            'COMPLIANCE',
      ObjectLockRetainUntilDate: retainUntil,
    }));
  }
}
