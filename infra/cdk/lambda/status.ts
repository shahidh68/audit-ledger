/**
 * Status Lambda — lets customers check whether a specific audit event was saved.
 *
 * GET /audit/events/{eventId}/status
 *
 * Accepts both key types so customers can use their existing ingest key
 * without needing a separate read key:
 *   - Ingest key  → tenant-scoped (can only check their own events)
 *   - Read key    → tenant-scoped or admin (can check any tenant's events)
 *
 * Responses:
 *   200 { event_id, saved: true,  tenant_id, timestamp } — event is in the ledger
 *   200 { event_id, saved: false }                       — not found (still processing or failed)
 *   401                                                  — invalid or missing key
 *
 * Environment variables (set by CDK):
 *   AUDIT_TABLE           — DynamoDB audit table name
 *   TENANT_KEY_SECRET_ARN — ingest key map (for customer self-service)
 *   READ_KEY_SECRET_ARN   — read key map   (for admin / dashboard users)
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createKeyCache } from './lib/secretsCache';
import { findEventById }  from './lib/auditRepository';
import { json }           from './lib/response';

const tenantKeyCache = createKeyCache('TENANT_KEY_SECRET_ARN');
const readKeyCache   = createKeyCache('READ_KEY_SECRET_ARN');

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const tableName = process.env.AUDIT_TABLE;
  if (!tableName) return json(500, { error: 'Server misconfiguration' });

  const eventId = event.pathParameters?.eventId ?? '';
  if (!eventId) return json(400, { error: 'Missing eventId path parameter' });

  const apiKey = event.headers['x-api-key'] ?? event.headers['X-Api-Key'];
  if (!apiKey) return json(401, { error: 'Missing API key' });

  const { tenantId, isAdmin } = await resolveKey(apiKey);
  if (!tenantId) return json(401, { error: 'Invalid API key' });

  let record: Record<string, unknown> | null;
  try {
    record = await findEventById(tableName, eventId);
  } catch (e) {
    console.error('[status] DynamoDB query failed', e);
    return json(500, { error: 'Query failed' });
  }

  // Enforce tenant scope — non-admin callers can only see their own events.
  if (record && !isAdmin && record.tenant_id !== tenantId) {
    record = null;
  }

  if (!record) {
    return json(200, { event_id: eventId, saved: false });
  }

  return json(200, {
    event_id:  eventId,
    saved:     true,
    tenant_id: record.tenant_id,
    timestamp: record.timestamp,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve an API key against both key stores.
 * Ingest keys are tried first — the common path for customer automation.
 * Returns null tenantId if the key is not found in either store.
 */
async function resolveKey(
  apiKey: string,
): Promise<{ tenantId: string | null; isAdmin: boolean }> {
  try {
    const tenantId = await tenantKeyCache.resolveTenantId(apiKey);
    if (tenantId) return { tenantId, isAdmin: false };
  } catch { /* fall through */ }

  try {
    const tenantId = await readKeyCache.resolveTenantId(apiKey);
    if (tenantId) return { tenantId, isAdmin: tenantId === '*' };
  } catch { /* both stores unreachable */ }

  return { tenantId: null, isAdmin: false };
}
