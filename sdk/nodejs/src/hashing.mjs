import { createHash } from 'node:crypto';

/**
 * SHA-256 of UTF-8 text — use for resume/candidate data before any network call.
 * Only the hex digest is sent to AI Audit Ledger (GDPR minimisation).
 */
export function hashPii(raw) {
  return createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

/** Hash system prompt text — never transmit raw prompts. */
export function hashPrompt(prompt) {
  return hashPii(prompt);
}
