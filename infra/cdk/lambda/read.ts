/**
 * Read Lambda — queries DynamoDB for the audit log and verifies tamper-evidence
 * by comparing DynamoDB records against the immutable S3 archive.
 *
 * Security:
 *  - Read/admin API keys fetched from Secrets Manager (never in env vars).
 *  - Multi-tenant: queries are scoped to the caller's tenant_id.
 *  - Admin key (tenant_id = "*") can query across all tenants.
 *
 * Tamper evidence:
 *  - The /history endpoint fetches the original record from S3 Object Lock
 *    and compares it to the DynamoDB copy. Any discrepancy is flagged.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, QueryCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const dynamo  = new DynamoDBClient({});
const s3      = new S3Client({});
const secrets = new SecretsManagerClient({});

// ── Secret cache ──────────────────────────────────────────────────────────────
let cachedReadKeyMap: Map<string, string> | null = null;

async function getReadKeyMap(): Promise<Map<string, string>> {
  if (cachedReadKeyMap) return cachedReadKeyMap;

  const secretArn = process.env.READ_KEY_SECRET_ARN;
  if (!secretArn) throw new Error('READ_KEY_SECRET_ARN not set');

  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const raw = result.SecretString ?? '{}';

  const map = new Map<string, string>();
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [k, v] of Object.entries(parsed)) {
      if (k && v) map.set(k.trim(), v.trim());
    }
  } catch {
    console.error('Failed to parse read key map from Secrets Manager');
  }

  cachedReadKeyMap = map;
  return map;
}

function invalidateReadKeyCache(): void {
  cachedReadKeyMap = null;
}

// ── Response helper ───────────────────────────────────────────────────────────
function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const tableName  = process.env.AUDIT_TABLE;
  const bucketName = process.env.AUDIT_BUCKET;

  if (!tableName || !bucketName) {
    return json(500, { error: 'Server misconfiguration' });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const presentedKey = event.headers['x-api-key'] ?? event.headers['X-Api-Key'];
  if (!presentedKey) return json(401, { error: 'Missing read API key' });

  let readKeyMap: Map<string, string>;
  try {
    readKeyMap = await getReadKeyMap();
  } catch (e) {
    console.error('Failed to load read keys', e);
    return json(500, { error: 'Server misconfiguration' });
  }

  let callerTenantId = readKeyMap.get(presentedKey);

  if (!callerTenantId) {
    invalidateReadKeyCache();
    try {
      readKeyMap = await getReadKeyMap();
      callerTenantId = readKeyMap.get(presentedKey);
    } catch { /* ignore */ }
  }

  if (!callerTenantId) return json(401, { error: 'Invalid read API key' });

  const isAdmin = callerTenantId === '*';
  const path    = event.path ?? '';
  const eventId = event.pathParameters?.eventId;
  const isHistory = Boolean(eventId) && /\/history\/?$/.test(path);

  try {
    // ── History / tamper-evidence check ────────────────────────────────────
    if (isHistory && eventId) {
      return await handleHistory(eventId, callerTenantId, isAdmin, tableName, bucketName);
    }

    // ── List logs ───────────────────────────────────────────────────────────
    return await handleList(event, callerTenantId, isAdmin, tableName);

  } catch (e) {
    console.error(e);
    return json(500, { error: 'Query failed', detail: String(e) });
  }
}

// ── List records ──────────────────────────────────────────────────────────────
async function handleList(
  event: APIGatewayProxyEvent,
  callerTenantId: string,
  isAdmin: boolean,
  tableName: string,
): Promise<APIGatewayProxyResult> {
  const from = event.queryStringParameters?.from;
  const to   = event.queryStringParameters?.to;

  let items: Record<string, unknown>[] = [];

  if (isAdmin) {
    // Admin: scan all records (add date filter if provided)
    const result = await dynamo.send(new ScanCommand({
      TableName: tableName,
      ...(from && to && {
        FilterExpression: '#ts >= :from AND #ts <= :to',
        ExpressionAttributeNames:  { '#ts': 'timestamp' },
        ExpressionAttributeValues: {
          ':from': { S: from },
          ':to':   { S: to },
        },
      }),
    }));
    items = (result.Items ?? []).map((i) => unmarshall(i));

  } else {
    // Tenant: query by tenant_id, filter by sk (timestamp#event_id) if date range given
    const keyCondition = from && to
      ? 'tenant_id = :tid AND sk BETWEEN :from AND :to'
      : 'tenant_id = :tid';

    const expressionValues: Record<string, { S: string }> = {
      ':tid': { S: callerTenantId },
    };
    if (from && to) {
      // Append # and ~ as range bookends so the comparison works against "timestamp#event_id"
      expressionValues[':from'] = { S: `${from}#` };
      expressionValues[':to']   = { S: `${to}~` };
    }

    const result = await dynamo.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: expressionValues,
      ScanIndexForward: false, // newest first
    }));
    items = (result.Items ?? []).map((i) => unmarshall(i));
  }

  // Remove internal sort key from response
  items.forEach((item) => delete item.sk);
  items.sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')));

  return json(200, {
    items,
    tenant_id: isAdmin ? undefined : callerTenantId,
    count: items.length,
  });
}

// ── History / tamper-evidence check ──────────────────────────────────────────
async function handleHistory(
  eventId: string,
  callerTenantId: string,
  isAdmin: boolean,
  tableName: string,
  bucketName: string,
): Promise<APIGatewayProxyResult> {
  // Look up the event in DynamoDB via the event_id-index GSI
  const queryResult = await dynamo.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'event_id-index',
    KeyConditionExpression: 'event_id = :eid',
    ExpressionAttributeValues: { ':eid': { S: eventId } },
  }));

  if (!queryResult.Items?.length) {
    return json(404, { error: 'Event not found' });
  }

  const dbRecord = unmarshall(queryResult.Items[0]);

  // Enforce tenant scope
  if (!isAdmin && dbRecord.tenant_id !== callerTenantId) {
    return json(404, { error: 'Event not found' });
  }

  const tenantId = String(dbRecord.tenant_id);
  delete dbRecord.sk;

  // Fetch the original record from S3 Object Lock archive
  let s3Record:         Record<string, unknown> | null = null;
  let integrityVerified = false;
  let integrityNote     = '';

  try {
    const s3Result = await s3.send(new GetObjectCommand({
      Bucket: bucketName,
      Key:    `${tenantId}/${eventId}.json`,
    }));
    const body = await s3Result.Body?.transformToString();
    s3Record = body ? JSON.parse(body) as Record<string, unknown> : null;
  } catch (e) {
    if (e instanceof NoSuchKey) {
      integrityNote = 'S3 archive record not found — may still be processing.';
    } else {
      integrityNote = 'Could not retrieve S3 archive for comparison.';
    }
  }

  if (s3Record) {
    // Compare the two copies. Serialise both with sorted keys for a stable comparison.
    const sortKeys = (o: unknown): unknown => {
      if (typeof o !== 'object' || o === null || Array.isArray(o)) return o;
      return Object.fromEntries(
        Object.keys(o as object).sort().map((k) => [k, sortKeys((o as Record<string, unknown>)[k])]),
      );
    };

    const dbJson = JSON.stringify(sortKeys(dbRecord));
    const s3Json = JSON.stringify(sortKeys(s3Record));

    integrityVerified = dbJson === s3Json;
    integrityNote = integrityVerified
      ? 'Record matches immutable S3 archive. No tampering detected.'
      : 'WARNING: Record does not match S3 archive. Possible tampering — investigate immediately.';
  }

  return json(200, {
    event_id:          eventId,
    integrity_verified: integrityVerified,
    integrity_note:    integrityNote,
    current_record:    dbRecord,
    archived_record:   s3Record,
  });
}
