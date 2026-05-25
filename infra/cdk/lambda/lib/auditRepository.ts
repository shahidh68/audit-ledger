/**
 * auditRepository — owns DynamoDB and S3 clients for the audit read path.
 * Isolates AWS SDK calls from the read Lambda handler so handler logic
 * stays free of SDK imports and is easier to test.
 */
import { DynamoDBClient, QueryCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const dynamo = new DynamoDBClient({});
const s3     = new S3Client({});

/** Query all events for a single tenant, optionally bounded by a date range. */
export async function listTenantEvents(
  tableName: string,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<Record<string, unknown>[]> {
  const keyCondition = from && to
    ? 'tenant_id = :tid AND sk BETWEEN :from AND :to'
    : 'tenant_id = :tid';

  const expressionValues: Record<string, { S: string }> = {
    ':tid': { S: tenantId },
  };
  if (from && to) {
    // Append # and ~ as range bookends so comparison works against "timestamp#event_id"
    expressionValues[':from'] = { S: `${from}#` };
    expressionValues[':to']   = { S: `${to}~` };
  }

  const result = await dynamo.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: keyCondition,
    ExpressionAttributeValues: expressionValues,
    ScanIndexForward: false, // newest first
  }));

  return (result.Items ?? []).map((i) => unmarshall(i));
}

/** Full-table scan (admin only), optionally filtered by timestamp range.
 *  Hard-capped at MAX_SCAN_ITEMS to prevent runaway scans on large tables.
 *  For pagination beyond the cap, callers should narrow the date range.
 */
const MAX_SCAN_ITEMS = 1000;

export async function scanAllEvents(
  tableName: string,
  from?: string,
  to?: string,
): Promise<Record<string, unknown>[]> {
  const result = await dynamo.send(new ScanCommand({
    TableName: tableName,
    Limit: MAX_SCAN_ITEMS,
    ...(from && to && {
      FilterExpression: '#ts >= :from AND #ts <= :to',
      ExpressionAttributeNames:  { '#ts': 'timestamp' },
      ExpressionAttributeValues: {
        ':from': { S: from },
        ':to':   { S: to },
      },
    }),
  }));

  return (result.Items ?? []).map((i) => unmarshall(i));
}

/** Look up a single event via the event_id-index GSI. Returns null if not found. */
export async function findEventById(
  tableName: string,
  eventId: string,
): Promise<Record<string, unknown> | null> {
  const result = await dynamo.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'event_id-index',
    KeyConditionExpression: 'event_id = :eid',
    ExpressionAttributeValues: { ':eid': { S: eventId } },
  }));

  return result.Items?.length ? unmarshall(result.Items[0]) : null;
}

export interface ArchivedRecordResult {
  record: Record<string, unknown> | null;
  /** Human-readable note; empty string when the fetch succeeded. */
  note: string;
}

/** Fetch the immutable S3 Object Lock copy of an event for tamper comparison. */
export async function fetchArchivedRecord(
  bucketName: string,
  tenantId: string,
  eventId: string,
): Promise<ArchivedRecordResult> {
  try {
    const s3Result = await s3.send(new GetObjectCommand({
      Bucket: bucketName,
      Key:    `${tenantId}/${eventId}.json`,
    }));
    const body = await s3Result.Body?.transformToString();
    const record = body ? JSON.parse(body) as Record<string, unknown> : null;
    return { record, note: '' };
  } catch (e) {
    const note = e instanceof NoSuchKey
      ? 'S3 archive record not found — may still be processing.'
      : 'Could not retrieve S3 archive for comparison.';
    return { record: null, note };
  }
}
