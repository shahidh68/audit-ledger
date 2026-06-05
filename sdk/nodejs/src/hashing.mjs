/**
 * Local hashing — raw PII never leaves the tenant's environment.
 *
 * By default this module uses HMAC-SHA256 keyed off the AUDIT_HMAC_KEY
 * environment variable. Keyed hashing makes the output non-reversible by
 * anyone who does not hold the key, which is what regulators (ICO / EDPB)
 * expect when you describe a value as pseudonymised rather than identifiable.
 *
 * Backwards-compatible fallback:
 *   If AUDIT_HMAC_KEY is not set, the functions fall back to plain SHA-256
 *   so existing deployments do not break. A one-time console warning is
 *   emitted on first use to nudge callers to upgrade. The default will flip
 *   in a future major version.
 *
 * Generate a key once per tenant and store it next to AUDIT_WRITE_KEY:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * The key never leaves your environment.
 */

import { createHash, createHmac } from 'node:crypto';

let _fallbackWarned = false;

function getKey() {
  const raw = (process.env.AUDIT_HMAC_KEY ?? '').trim();
  return raw.length > 0 ? raw : null;
}

function warnFallbackOnce() {
  if (_fallbackWarned) return;
  _fallbackWarned = true;
  // Use console.warn rather than throwing — this is a deprecation nudge,
  // not an error. Existing callers must continue to work unchanged.
  console.warn(
    '[ai-audit-ledger] AUDIT_HMAC_KEY is not set; falling back to plain ' +
    'SHA-256 for PII hashing. Plain SHA-256 of low-entropy values (names, ' +
    'emails) is brute-forceable and should not be treated as anonymisation ' +
    'under ICO/EDPB guidance. Set AUDIT_HMAC_KEY to a 32+ byte secret to ' +
    'switch to keyed HMAC-SHA256. This fallback will be removed in a ' +
    'future major version.'
  );
}

/**
 * Hash arbitrary text (e.g. resume body, candidate name) before sending.
 * Returns a lowercase 64-char hex digest. The format is identical whether
 * HMAC or plain SHA-256 is used, so the wire format does not change.
 */
export function hashPii(raw) {
  const data = String(raw);
  const key = getKey();
  if (key === null) {
    warnFallbackOnce();
    return createHash('sha256').update(data, 'utf8').digest('hex');
  }
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

/** Hash system prompt text — never transmit raw prompts. */
export function hashPrompt(prompt) {
  return hashPii(prompt);
}

/**
 * Test-only hook. Resets the one-time warned flag so unit tests can assert
 * the warning fires exactly once per process. Not part of the public API.
 * @internal
 */
export function _resetFallbackWarnedForTests() {
  _fallbackWarned = false;
}
