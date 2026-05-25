import { randomUUID } from 'node:crypto';
import { hashPii, hashPrompt } from './hashing.mjs';

// ─── internal helpers ────────────────────────────────────────────────────────

function utcIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Cross-runtime macrotask defer.
 * setImmediate  → Node.js
 * setTimeout(0) → browsers and edge runtimes (Workers, Deno, Bun)
 */
const defer = typeof setImmediate === 'function'
  ? (fn) => setImmediate(fn)
  : (fn) => setTimeout(fn, 0);

/**
 * Exponential backoff with full jitter.
 * Retries only on network errors and 5xx responses; 4xx (including 429) are not retried.
 *
 * @param {() => Promise<Response>} fn   — the fetch call to attempt
 * @param {number}                  attempts — total attempts (1 = no retry)
 * @param {number}                  baseMs   — initial backoff in ms
 */
async function withRetry(fn, attempts = 3, baseMs = 200) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fn();
      if (res.ok || res.status < 500) return res;   // success or non-retryable
      lastErr = new AuditLedgerError(`HTTP ${res.status}`, res.status);
    } catch (err) {
      lastErr = err;                                  // network / timeout error
    }
    if (i < attempts - 1) {
      const jitter = Math.random() * baseMs;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i + jitter));
    }
  }
  throw lastErr;
}

// ─── public error type ───────────────────────────────────────────────────────

export class AuditLedgerError extends Error {
  /** @param {string} message  @param {number|null} status  HTTP status, or null for network errors */
  constructor(message, status = null) {
    super(`[ai-audit-ledger] ${message}`);
    this.name = 'AuditLedgerError';
    this.status = status;
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * POST one AI decision event to the audit ledger and await confirmation.
 *
 * @param {object}  opts
 * @param {string}  opts.ingestUrl          — API Gateway ingest endpoint
 * @param {string}  opts.tenantApiKey       — tenant write key (sent as x-api-key)
 * @param {string}  opts.rawSystemPrompt    — hashed locally before sending
 * @param {string}  opts.rawUserInput       — hashed locally before sending
 * @param {string}  opts.modelVersion
 * @param {object}  opts.aiDecisionOutput
 * @param {boolean} opts.humanInLoop
 * @param {string}  [opts.eventId]          — UUID v4; generated if omitted
 * @param {number}  [opts.timeoutMs=5000]   — per-attempt fetch timeout in ms
 * @param {number}  [opts.retries=3]        — total attempts (1 = no retry)
 * @param {typeof globalThis.fetch} [opts.fetchImpl]
 */
export async function logDecisionAsync({
  ingestUrl,
  tenantApiKey,
  rawSystemPrompt,
  rawUserInput,
  modelVersion,
  aiDecisionOutput,
  humanInLoop,
  eventId,
  timeoutMs = 5_000,
  retries = 3,
  fetchImpl = globalThis.fetch,
}) {
  const url = ingestUrl.replace(/\/$/, '');
  const payload = {
    event_id:           eventId ?? randomUUID(),
    timestamp:          utcIso(),
    tenant_api_key:     tenantApiKey,
    model_version:      modelVersion,
    system_prompt_hash: hashPrompt(rawSystemPrompt),
    input_data_hash:    hashPii(rawUserInput),
    ai_decision_output: aiDecisionOutput,
    human_in_loop:      humanInLoop,
  };

  const res = await withRetry(
    () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      return fetchImpl(url, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept:         'application/json',
          'x-api-key':    tenantApiKey,
        },
        body:   JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
    },
    retries,
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AuditLedgerError(`ingest failed: HTTP ${res.status} ${body}`, res.status);
  }
}

/**
 * Fire-and-forget: defers ingestion to the next macrotask so the caller returns immediately.
 * Works in Node.js, browsers, and edge runtimes.
 * Errors are emitted to console.error and never thrown.
 *
 * @param {Parameters<typeof logDecisionAsync>[0]} args
 */
export function scheduleLogDecision(args) {
  defer(() => {
    logDecisionAsync(args).catch((err) => console.error(err));
  });
}

export { hashPii, hashPrompt };
