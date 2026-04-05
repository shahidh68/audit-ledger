import { randomUUID } from 'node:crypto';
import { hashPii, hashPrompt } from './hashing.mjs';

function utcIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Async POST to API Gateway — does not block the JS event loop beyond one microtask chain;
 * use scheduleLogDecision() from sync hot paths to defer work to the next tick.
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
  fetchImpl = globalThis.fetch,
}) {
  const payload = {
    event_id: eventId ?? randomUUID(),
    timestamp: utcIso(),
    tenant_api_key: tenantApiKey,
    model_version: modelVersion,
    system_prompt_hash: hashPrompt(rawSystemPrompt),
    input_data_hash: hashPii(rawUserInput),
    ai_decision_output: aiDecisionOutput,
    human_in_loop: humanInLoop,
  };

  const res = await fetchImpl(ingestUrl.replace(/\/$/, ''), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': tenantApiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI Audit Ledger ingest failed: HTTP ${res.status} ${text}`);
  }
}

/**
 * Fire-and-forget: schedules ingestion on the next macrotask so callers return immediately.
 */
export function scheduleLogDecision(args) {
  setImmediate(() => {
    logDecisionAsync(args).catch((err) => {
      console.error('[ai-audit-ledger]', err);
    });
  });
}

export { hashPii, hashPrompt };
