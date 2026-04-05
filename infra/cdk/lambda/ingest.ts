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
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

const sqs = new SQSClient({});
const dynamo = new DynamoDBClient({});
const secrets = new SecretsManagerClient({});

// ── Secret cache (lives for the duration of the Lambda container) ─────────────
let cachedTenantKeyMap: Map<string, string> | null = null;

async function getTenantKeyMap(): Promise<Map<string, string>> {
  if (cachedTenantKeyMap) return cachedTenantKeyMap;

  const secretArn = process.env.TENANT_KEY_SECRET_ARN;
  if (!secretArn) throw new Error('TENANT_KEY_SECRET_ARN not set');

  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const raw = result.SecretString ?? '{}';

  const map = new Map<string, string>();
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [k, v] of Object.entries(parsed)) {
      if (k && v) map.set(k.trim(), v.trim());
    }
  } catch {
    console.error('Failed to parse tenant key map from Secrets Manager');
  }

  cachedTenantKeyMap = map;
  return map;
}

// Call this when a key is rejected to force re-fetch on next request
// (handles key rotation without redeployment).
function invalidateKeyCache(): void {
  cachedTenantKeyMap = null;
}

// ── Per-tenant rate limiting ──────────────────────────────────────────────────
// Uses a DynamoDB item per {tenantId}#{minuteWindow} with an atomic counter.
// TTL ensures items expire automatically after 2 minutes.

async function checkRateLimit(tenantId: string): Promise<{ allowed: boolean; count: number }> {
  const tableName = process.env.RATE_LIMIT_TABLE;
  const limit = parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? '100', 10);
  if (!tableName) return { allowed: true, count: 0 }; // fail open if misconfigured

  const windowStart = Math.floor(Date.now() / 60_000); // current minute
  const pk = `${tenantId}#${windowStart}`;
  const ttl = Math.floor(Date.now() / 1000) + 120; // expire after 2 minutes

  const result = await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { pk: { S: pk } },
      UpdateExpression: 'ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)',
      ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':ttl': { N: String(ttl) },
      },
      ReturnValues: 'ALL_NEW',
    }),
  );

  const count = parseInt(result.Attributes?.count?.N ?? '1', 10);
  return { allowed: count <= limit, count };
}

// ── Response helper ───────────────────────────────────────────────────────────
function json(statusCode: number, body: unknown, extra?: Record<string, string>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...extra,
    },
    body: JSON.stringify(body),
  };
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

  if (!apiKey) {
    return json(401, { error: 'Missing API key' });
  }

  let tenantKeyMap: Map<string, string>;
  try {
    tenantKeyMap = await getTenantKeyMap();
  } catch (e) {
    console.error('Failed to load tenant keys', e);
    return json(500, { error: 'Server misconfiguration' });
  }

  let tenantId = tenantKeyMap.get(apiKey);

  // If not found, invalidate cache and retry once (handles key rotation)
  if (!tenantId) {
    invalidateKeyCache();
    try {
      tenantKeyMap = await getTenantKeyMap();
      tenantId = tenantKeyMap.get(apiKey);
    } catch {
      // ignore
    }
  }

  if (!tenantId) {
    return json(401, { error: 'Invalid API key' });
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────
  const { allowed, count } = await checkRateLimit(tenantId);
  const limit = parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? '100', 10);

  if (!allowed) {
    console.warn({ tenantId, count, limit, message: 'Rate limit exceeded' });
    return json(
      429,
      { error: 'Rate limit exceeded', limit_per_minute: limit },
      { 'Retry-After': '60', 'X-RateLimit-Limit': String(limit), 'X-RateLimit-Remaining': '0' },
    );
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const {
    event_id,
    timestamp,
    model_version,
    system_prompt_hash,
    input_data_hash,
    ai_decision_output,
    human_in_loop,
  } = payload;

  if (typeof event_id !== 'string' || !UUID4.test(event_id)) {
    return json(400, { error: 'event_id must be UUID v4' });
  }
  if (typeof timestamp !== 'string' || !timestamp.length) {
    return json(400, { error: 'timestamp must be ISO 8601 string' });
  }
  if (typeof model_version !== 'string' || !model_version.length) {
    return json(400, { error: 'model_version required' });
  }
  if (typeof system_prompt_hash !== 'string' || !SHA256.test(system_prompt_hash)) {
    return json(400, { error: 'system_prompt_hash must be SHA-256 hex' });
  }
  if (typeof input_data_hash !== 'string' || !SHA256.test(input_data_hash)) {
    return json(400, { error: 'input_data_hash must be SHA-256 hex' });
  }
  if (
    typeof ai_decision_output !== 'object' ||
    ai_decision_output === null ||
    Array.isArray(ai_decision_output)
  ) {
    return json(400, { error: 'ai_decision_output must be a JSON object' });
  }
  if (typeof human_in_loop !== 'boolean') {
    return json(400, { error: 'human_in_loop must be boolean' });
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

  return {
    statusCode: 202,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': String(Math.max(0, limit - count)),
    },
    body: JSON.stringify({ message: 'Accepted', event_id }),
  };
}
