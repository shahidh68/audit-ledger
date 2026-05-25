/**
 * Centralised defaults for all Lambda configuration.
 *
 * Env vars are the source of truth at runtime; these constants are the
 * fallbacks used when a variable is absent or unparseable.
 */

export const RATE_LIMIT_DEFAULT      = 100;  // requests per tenant per minute
export const RATE_LIMIT_WINDOW_MS    = 60_000; // 1 minute in milliseconds
export const RATE_LIMIT_TTL_S        = 120;  // DynamoDB item TTL (2 minutes)
export const RETENTION_YEARS_DEFAULT = 7;    // EU AI Act Article 12 minimum

/**
 * Parse an integer from an environment variable.
 * Returns `fallback` if the variable is absent or not a valid integer.
 */
export function parseEnvInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}
