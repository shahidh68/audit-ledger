/**
 * Read-side helpers for the AI Audit Ledger API.
 *
 * The ingest path is fire-and-forget by design and needs no read setup.
 * This module covers the read-side calls that complement it: verifyDecision
 * (tamper-evidence check for one record), verifyCompleteness (proof that no
 * records have been deleted), and listDecisions (browse recent records).
 *
 * Auth uses a read key (separate namespace from the write key). Read keys
 * cannot write; write keys cannot read.
 */

import { AuditLedgerError } from './index.mjs';

/**
 * @typedef {object} DecisionRecord
 * @property {string}                event_id
 * @property {string}                timestamp
 * @property {string}                [tenant_id]
 * @property {string}                model_version
 * @property {string}                system_prompt_hash
 * @property {string}                input_data_hash
 * @property {Record<string,unknown>} ai_decision_output
 * @property {boolean}               human_in_loop
 * @property {number}                [sequence_no] - present from v0.3 onward
 */

/**
 * @typedef {object} TamperCheckResult
 * @property {string}          event_id
 * @property {boolean}         integrity_verified
 * @property {string}          integrity_note
 * @property {DecisionRecord}  current_record   - the DynamoDB copy
 * @property {DecisionRecord}  archived_record  - the S3 Object Lock copy
 */

/**
 * @typedef {object} CompletenessResult
 * @property {string}              tenant_id
 * @property {{from: number, to: number}} range
 * @property {number}              expected_count
 * @property {number}              found_count
 * @property {number[]}            missing
 * @property {string}              note
 */

/**
 * @typedef {object} ListDecisionsResult
 * @property {DecisionRecord[]} items
 * @property {number}           count
 * @property {string}           [tenant_id]  - omitted for admin callers (cross-tenant)
 */

// ── internal: GET with retry, shared by all three read helpers ──────────────

async function getJsonWithRetry({
  url,
  readKey,
  endpointName,
  timeoutMs,
  retries,
  fetchImpl,
}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'x-api-key': readKey },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return await res.json();
      if (res.status < 500) {
        const body = await res.text().catch(() => '');
        throw new AuditLedgerError(
          `${endpointName} failed: HTTP ${res.status} ${body}`,
          res.status,
        );
      }
      lastErr = new AuditLedgerError(`HTTP ${res.status}`, res.status);
    } catch (err) {
      clearTimeout(timer);
      // 4xx errors thrown above are terminal; do not retry.
      if (err instanceof AuditLedgerError && err.status && err.status < 500) {
        throw err;
      }
      lastErr = err;
    }
    if (attempt < retries - 1) {
      const baseMs = 200;
      const jitter = Math.random() * baseMs;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt + jitter));
    }
  }
  throw lastErr;
}

// ── verify_decision ─────────────────────────────────────────────────────────

/**
 * Tamper-evidence check for one specific recorded decision.
 *
 * The ledger fetches both the DynamoDB copy (the queryable index) and the S3
 * Object Lock copy (the immutable archive) of the requested event and compares
 * them with stable JSON serialisation. integrity_verified is true when they
 * match exactly. A mismatch flips it to false with a warning in the note.
 *
 * @param {object}  opts
 * @param {string}  opts.apiUrl     - Base API URL (no trailing /audit segment).
 * @param {string}  opts.readKey    - Tenant read key, sent as x-api-key.
 * @param {string}  opts.eventId    - UUID v4 of the event to verify.
 * @param {number}  [opts.timeoutMs=10000]
 * @param {number}  [opts.retries=3]
 * @param {typeof globalThis.fetch} [opts.fetchImpl]
 * @returns {Promise<TamperCheckResult>}
 */
export async function verifyDecision({
  apiUrl,
  readKey,
  eventId,
  timeoutMs = 10_000,
  retries = 3,
  fetchImpl = globalThis.fetch,
}) {
  if (!eventId) throw new AuditLedgerError('eventId is required for verifyDecision');
  const base = apiUrl.replace(/\/+$/, '');
  const url = `${base}/audit/events/${encodeURIComponent(eventId)}/history`;
  return /** @type {TamperCheckResult} */ (
    await getJsonWithRetry({
      url,
      readKey,
      endpointName: 'verify_decision',
      timeoutMs,
      retries,
      fetchImpl,
    })
  );
}

// ── verify_completeness ─────────────────────────────────────────────────────

/**
 * Detect deleted or omitted audit records for the caller's tenant.
 *
 * The ledger compares its per-tenant monotonic sequence counter against
 * the records actually present in storage and returns any sequence numbers
 * that are missing. Each gap is a record that was deleted, lost during SQS
 * redelivery, or never stored. The processor logs burned_sequence entries
 * for the redelivery case so operators can distinguish deliberate deletion
 * from observable infrastructure noise.
 *
 * @param {object}  opts
 * @param {string}  opts.apiUrl     - Base API URL (no trailing /audit segment).
 * @param {string}  opts.readKey    - Tenant read key, sent as x-api-key.
 * @param {number}  [opts.from]     - Inclusive lower bound on sequence_no.
 * @param {number}  [opts.to]       - Inclusive upper bound on sequence_no.
 * @param {string}  [opts.tenantId] - Required only with the admin read key.
 * @param {number}  [opts.timeoutMs=10000]
 * @param {number}  [opts.retries=3]
 * @param {typeof globalThis.fetch} [opts.fetchImpl]
 * @returns {Promise<CompletenessResult>}
 */
export async function verifyCompleteness({
  apiUrl,
  readKey,
  from,
  to,
  tenantId,
  timeoutMs = 10_000,
  retries = 3,
  fetchImpl = globalThis.fetch,
}) {
  const base = apiUrl.replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (typeof from === 'number') params.set('from', String(from));
  if (typeof to   === 'number') params.set('to',   String(to));
  if (tenantId) params.set('tenant_id', tenantId);
  const url = `${base}/audit/verify-completeness${params.toString() ? `?${params}` : ''}`;
  return /** @type {CompletenessResult} */ (
    await getJsonWithRetry({
      url,
      readKey,
      endpointName: 'verify_completeness',
      timeoutMs,
      retries,
      fetchImpl,
    })
  );
}

// ── list_decisions ──────────────────────────────────────────────────────────

/**
 * Browse recent audit records for the caller's tenant.
 *
 * Optional from/to query parameters filter to a date range (ISO 8601 strings,
 * compared lexicographically against the sort key which encodes timestamp).
 * Tenant-scoped automatically by the read key; an admin key returns records
 * across all tenants.
 *
 * @param {object}  opts
 * @param {string}  opts.apiUrl     - Base API URL (no trailing /audit segment).
 * @param {string}  opts.readKey    - Tenant read key, sent as x-api-key.
 * @param {string}  [opts.from]     - Inclusive lower bound on timestamp (ISO 8601).
 * @param {string}  [opts.to]       - Inclusive upper bound on timestamp (ISO 8601).
 * @param {number}  [opts.timeoutMs=10000]
 * @param {number}  [opts.retries=3]
 * @param {typeof globalThis.fetch} [opts.fetchImpl]
 * @returns {Promise<ListDecisionsResult>}
 */
export async function listDecisions({
  apiUrl,
  readKey,
  from,
  to,
  timeoutMs = 10_000,
  retries = 3,
  fetchImpl = globalThis.fetch,
}) {
  const base = apiUrl.replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to)   params.set('to',   to);
  const url = `${base}/audit/logs${params.toString() ? `?${params}` : ''}`;
  return /** @type {ListDecisionsResult} */ (
    await getJsonWithRetry({
      url,
      readKey,
      endpointName: 'list_decisions',
      timeoutMs,
      retries,
      fetchImpl,
    })
  );
}
