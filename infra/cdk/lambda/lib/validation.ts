/**
 * Shared validation patterns and helpers for ingestion payloads.
 *
 * These mirror the Python validators in schemas/ingestion.py — both must be
 * kept in sync if the format requirements ever change.
 */

export const UUID4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA256 = /^[0-9a-f]{64}$/i;

/**
 * Validates a parsed ingestion payload.
 * Returns an error message string if any field is invalid, or null if valid.
 */
export function validateIngestionPayload(payload: Record<string, unknown>): string | null {
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
    return 'event_id must be UUID v4';
  }
  if (typeof timestamp !== 'string' || !timestamp.length) {
    return 'timestamp must be ISO 8601 string';
  }
  if (typeof model_version !== 'string' || !model_version.length) {
    return 'model_version required';
  }
  if (typeof system_prompt_hash !== 'string' || !SHA256.test(system_prompt_hash)) {
    return 'system_prompt_hash must be SHA-256 hex';
  }
  if (typeof input_data_hash !== 'string' || !SHA256.test(input_data_hash)) {
    return 'input_data_hash must be SHA-256 hex';
  }
  if (typeof ai_decision_output !== 'object' || ai_decision_output === null || Array.isArray(ai_decision_output)) {
    return 'ai_decision_output must be a JSON object';
  }
  if (typeof human_in_loop !== 'boolean') {
    return 'human_in_loop must be boolean';
  }

  return null;
}
