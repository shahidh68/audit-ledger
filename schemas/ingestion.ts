/**
 * AI Audit Ledger — ingestion payload (EU AI Act Article 12 traceability).
 * Raw PII must never appear here; only hashes and decision metadata.
 */

/** UUID v4 string */
export type UuidV4 = string;

/** ISO 8601 UTC datetime string */
export type Iso8601Utc = string;

/** Lowercase hex SHA-256 (64 chars) */
export type Sha256Hex = string;

export interface AiAuditIngestionPayload {
  /** Unique idempotency / correlation id for this decision event */
  event_id: UuidV4;
  /** When the AI decision was produced (UTC) */
  timestamp: Iso8601Utc;
  /** B2B tenant credential (never logged as PII in application logs) */
  tenant_api_key: string;
  /** Model or pipeline identifier */
  model_version: string;
  /** SHA-256 of system prompt — we never store the prompt */
  system_prompt_hash: Sha256Hex;
  /** SHA-256 of user/resume input — PII hashed client-side */
  input_data_hash: Sha256Hex;
  /** Structured model output (no raw PII) */
  ai_decision_output: Record<string, unknown>;
  /** Whether a human reviewed the output */
  human_in_loop: boolean;
}
