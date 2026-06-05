/**
 * Read-side helpers for the AI Audit Ledger API.
 *
 * The ingest path is fire-and-forget by design and needs no read setup.
 * This module covers the small read-side calls that complement it: today
 * verifyCompleteness; future verifyDecision and listDecisions if needed.
 *
 * Auth uses a read key (separate namespace from the write key). Read keys
 * cannot write; write keys cannot read.
 */

import { AuditLedgerError } from './index.mjs';

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
 * @param {string}  opts.apiUrl     — Base API URL (no trailing /audit segment).
 * @param {string}  opts.readKey    — Tenant read key, sent as x-api-key.
 * @param {number}  [opts.from]     — Inclusive lower bound on sequence_no.
 * @param {number}  [opts.to]       — Inclusive upper bound on sequence_no.
 * @param {string}  [opts.tenantId] — Required only with the admin read key.
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
      if (res.ok) return /** @type {CompletenessResult} */ (await res.json());
      if (res.status < 500) {
        const body = await res.text().catch(() => '');
        throw new AuditLedgerError(
          `verify_completeness failed: HTTP ${res.status} ${body}`,
          res.status,
        );
      }
      lastErr = new AuditLedgerError(`HTTP ${res.status}`, res.status);
    } catch (err) {
      clearTimeout(timer);
      // Only swallow into retry on network/timeout errors, not on our own
      // AuditLedgerError thrown from a 4xx body — those are terminal.
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
