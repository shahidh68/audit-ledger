/**
 * Ingestion Lambda — validates tenant API key + payload, enforces per-tenant
 * rate limiting, enqueues to SQS, returns 202 quickly.
 *
 * Security:
 *  - API keys fetched from Secrets Manager (never in env vars).
 *  - tenant_id (not the raw key) stored in ledger documents.
 *  - Per-tenant rate limiting via DynamoDB atomic counters.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createKeyCache } from './lib/secretsCache';
import { parseEnvInt, RATE_LIMIT_DEFAULT, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_TTL_S } from './lib/config';
import { validateIngestionPayload } from './lib/validation';
import { isDuplicateEventId } from './lib/eventIdGuard';
import { json } from './lib/response';

const sqs    = new SQSClient({});
const dynamo = new DynamoDBClient({});

const tenantKeyCache = createKeyCache('TENANT_KEY_SECRET_ARN');

// Parsed once at module load — env vars are set before the first invocation.
const RATE_LIMIT = parseEnvInt('RATE_LIMIT_PER_MINUTE', RATE_LIMIT_DEFAULT);

// ── Per-tenant rate limiting ──────────────────────────────────────────────────
// Uses a DynamoDB item per {tenantId}#{minuteWindow} with an atomic counter.
// TTL ensures items expire automatically after 2 minutes.
async function checkRateLimit(tenantId: string): Promise<{ allowed: boolean; count: number }> {
  const tableName = process.env.RATE_LIMIT_TABLE;
  if (!tableName) return { allowed: true, count: 0 }; // fail open if misconfigured

  const windowStart = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS);
  const pk  = `${tenantId}#${windowStart}`;
  const ttl = Math.floor(Date.now() / 1000) + RATE_LIMIT_TTL_S;

  const result = await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { pk: { S: pk } },
      UpdateExpression: 'ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)',
      ExpressionAttributeNames:  { '#count': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':one': { N: '1'         },
        ':ttl': { N: String(ttl) },
      },
      ReturnValues: 'ALL_NEW',
    }),
  );

  const count = parseInt(result.Attributes?.count?.N ?? '1', 10);
  return { allowed: count <= RATE_LIMIT, count };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const queueUrl = process.env.QUEUE_URL;
  if (!queueUrl) {
    console.error('QUEUE_URL missing');
    return json(500, { error: 'Server misconfiguration' });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const apiKey =
    event.headers['x-api-key'] ??
    event.headers['X-Api-Key'] ??
    event.headers['x-apikey'];

  if (!apiKey) return json(401, { error: 'Missing API key' });

  let tenantId: string | null;
  try {
    tenantId = await tenantKeyCache.resolveTenantId(apiKey);
  } catch (e) {
    console.error('Failed to load tenant keys', e);
    return json(500, { error: 'Server misconfiguration' });
  }

  if (!tenantId) return json(401, { error: 'Invalid API key' });

  // ── Rate limiting ─────────────────────────────────────────────────────────
  const { allowed, count } = await checkRateLimit(tenantId);
  if (!allowed) {
    console.warn({ tenantId, count, limit: RATE_LIMIT, message: 'Rate limit exceeded' });
    return json(
      429,
      { error: 'Rate limit exceeded', limit_per_minute: RATE_LIMIT },
      { 'Retry-After': '60', 'X-RateLimit-Limit': String(RATE_LIMIT), 'X-RateLimit-Remaining': '0' },
    );
  }

  // ── Parse & validate body ─────────────────────────────────────────────────
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const validationError = validateIngestionPayload(payload);
  if (validationError) return json(400, { error: validationError });

  const { event_id } = payload;

  // ── Duplicate check ───────────────────────────────────────────────────────
  // Reject events with an event_id already in the ledger for this tenant.
  // Prevents double-counting when a customer retries a request they already sent.
  const auditTableName = process.env.AUDIT_TABLE;
  if (auditTableName && event_id) {
    try {
      const duplicate = await isDuplicateEventId(auditTableName, tenantId, String(event_id));
      if (duplicate) {
        console.warn({ tenantId, event_id, message: 'Duplicate event_id rejected' });
        return json(409, { error: 'Duplicate event_id — this event has already been recorded', event_id });
      }
    } catch (e) {
      // Log but don't block ingestion — a failed check should not drop events.
      console.error('Duplicate check failed, proceeding', e);
    }
  }

  // Strip raw API key from payload, add tenant_id
  const { tenant_api_key: _drop, ...safePayload } = payload as Record<string, unknown> & {
    tenant_api_key?: unknown;
  };

  const messageBody = JSON.stringify({
    ...safePayload,
    tenant_id: tenantId,
    _ingested_at: new Date().toISOString(),
  });

  // ── Enqueue ───────────────────────────────────────────────────────────────
  try {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: messageBody }));
  } catch (e) {
    console.error('SQS send failed', e);
    return json(502, { error: 'Failed to enqueue audit event' });
  }

  return json(
    202,
    { message: 'Accepted', event_id },
    {
      'X-RateLimit-Limit':     String(RATE_LIMIT),
      'X-RateLimit-Remaining': String(Math.max(0, RATE_LIMIT - count)),
    },
  );
}
