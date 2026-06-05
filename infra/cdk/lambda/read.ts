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
import { createKeyCache } from './lib/secretsCache';
import { json } from './lib/response';
import {
  listTenantEvents,
  scanAllEvents,
  findEventById,
  fetchArchivedRecord,
  listTenantSequenceNumbers,
} from './lib/auditRepository';
import { readCurrentSequence } from './lib/sequenceAllocator';
import { computeCompleteness } from './lib/completeness';

const readKeyCache = createKeyCache('READ_KEY_SECRET_ARN');

// ── Handler ───────────────────────────────────────────────────────────────────
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const tableName         = process.env.AUDIT_TABLE;
  const bucketName        = process.env.AUDIT_BUCKET;
  const sequenceTableName = process.env.TENANT_SEQUENCE_TABLE;
  if (!tableName || !bucketName) return json(500, { error: 'Server misconfiguration' });

  // ── Auth ──────────────────────────────────────────────────────────────────
  const presentedKey = event.headers['x-api-key'] ?? event.headers['X-Api-Key'];
  if (!presentedKey) return json(401, { error: 'Missing read API key' });

  let callerTenantId: string | null;
  try {
    callerTenantId = await readKeyCache.resolveTenantId(presentedKey);
  } catch (e) {
    console.error('Failed to load read keys', e);
    return json(500, { error: 'Server misconfiguration' });
  }
  if (!callerTenantId) return json(401, { error: 'Invalid read API key' });

  // ── Route ─────────────────────────────────────────────────────────────────
  const isAdmin         = callerTenantId === '*';
  const eventId         = event.pathParameters?.eventId;
  const path            = event.path ?? '';
  const isHistory       = Boolean(eventId) && /\/history\/?$/.test(path);
  const isCompleteness  = /\/verify-completeness\/?$/.test(path);

  try {
    if (isCompleteness) {
      if (!sequenceTableName) {
        return json(500, { error: 'Server misconfiguration: sequence table not bound' });
      }
      return await handleCompleteness(event, callerTenantId, isAdmin, tableName, sequenceTableName);
    }
    if (isHistory && eventId) {
      return await handleHistory(eventId, callerTenantId, isAdmin, tableName, bucketName);
    }
    return await handleList(event, callerTenantId, isAdmin, tableName);
  } catch (e) {
    console.error('Query failed', e);
    return json(500, { error: 'Query failed' });
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

  const rawItems = isAdmin
    ? await scanAllEvents(tableName, from, to)
    : await listTenantEvents(tableName, callerTenantId, from, to);

  // Remove internal sort key and return newest-first
  const items = rawItems
    .map(({ sk: _sk, ...rest }) => rest)
    .sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')));

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
  const rawRecord = await findEventById(tableName, eventId);
  if (!rawRecord) return json(404, { error: 'Event not found' });

  // Enforce tenant scope
  if (!isAdmin && rawRecord.tenant_id !== callerTenantId) {
    return json(404, { error: 'Event not found' });
  }

  const tenantId = String(rawRecord.tenant_id);
  const { sk: _sk, ...dbRecord } = rawRecord;

  // Fetch the original record from S3 Object Lock archive
  const { record: s3Record, note: archiveNote } = await fetchArchivedRecord(bucketName, tenantId, eventId);

  let integrityVerified = false;
  let integrityNote     = archiveNote;

  if (s3Record) {
    // Compare the two copies. Serialise both with sorted keys for a stable comparison.
    const sortKeys = (o: unknown): unknown => {
      if (typeof o !== 'object' || o === null || Array.isArray(o)) return o;
      return Object.fromEntries(
        Object.keys(o as object).sort().map((k) => [k, sortKeys((o as Record<string, unknown>)[k])]),
      );
    };

    integrityVerified = JSON.stringify(sortKeys(dbRecord)) === JSON.stringify(sortKeys(s3Record));
    integrityNote = integrityVerified
      ? 'Record matches immutable S3 archive. No tampering detected.'
      : 'WARNING: Record does not match S3 archive. Possible tampering — investigate immediately.';
  }

  return json(200, {
    event_id:           eventId,
    integrity_verified: integrityVerified,
    integrity_note:     integrityNote,
    current_record:     dbRecord,
    archived_record:    s3Record,
  });
}

// ── Completeness check ───────────────────────────────────────────────────────
// Returns the list of sequence numbers that were issued but are no longer
// present in DynamoDB. Each gap is a record that was either deleted, never
// fully stored (race during SQS redelivery), or lost in flight. Combined
// with the burned_sequence log entries from the processor, the operator
// can tell the three apart.
async function handleCompleteness(
  event: APIGatewayProxyEvent,
  callerTenantId: string,
  isAdmin: boolean,
  tableName: string,
  sequenceTableName: string,
): Promise<APIGatewayProxyResult> {
  // For now, completeness is tenant-scoped only. An admin caller must
  // pass ?tenant_id=<id> explicitly so they cannot accidentally trigger
  // a full-fleet sweep.
  const requestedTenantId = event.queryStringParameters?.tenant_id;
  const targetTenantId = isAdmin
    ? (requestedTenantId ?? '').trim()
    : callerTenantId;

  if (isAdmin && !targetTenantId) {
    return json(400, {
      error: 'Admin callers must specify ?tenant_id=<id> on verify-completeness',
    });
  }

  const fromParam = parsePositiveInt(event.queryStringParameters?.from);
  const toParam   = parsePositiveInt(event.queryStringParameters?.to);

  const [presentSequences, currentCounter] = await Promise.all([
    listTenantSequenceNumbers(tableName, targetTenantId),
    readCurrentSequence(sequenceTableName, targetTenantId),
  ]);

  const report = computeCompleteness({
    presentSequences,
    currentCounter,
    fromParam,
    toParam,
  });

  return json(200, {
    tenant_id: targetTenantId,
    ...report,
  });
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return n;
}
