# AI Audit Ledger — Architecture & SDK Alignment

This document maps the deployed AWS infrastructure to the SDK source code. It explains *what* each piece does, *why* it exists, and *where* in the code you can find it.

---

## How data flows through the system

The diagram below shows the full journey of an audit event — from the moment your application logs a decision, all the way to the tamper-proof vault. Think of it as a one-way conveyor belt: events go in, get verified, queued, and permanently stored. The read path runs separately and can cross-check the two storage copies at any time.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Your application  (SDK)                                            │
│  Personal data is fingerprinted here — raw values never leave       │
└────────────────────────┬────────────────────────────────────────────┘
                         │ HTTPS POST /audit/events
                         │ x-api-key: <tenant key>
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  API Gateway  — the front door                                      │
│  Checks the key exists · enforces 100 req/s rate cap               │
└──────────┬──────────────────────────────┬───────────────────────────┘
           │ write                        │ read
           ▼                              ▼
┌──────────────────────┐       ┌──────────────────────┐
│  Ingest Lambda       │       │  Read Lambda          │
│  Validates payload   │       │  Queries records      │
│  Returns 202 fast    │       │  integrity check      │
└──────┬───────────────┘       └──────┬───────┬────────┘
       │                              │       │
       │ (key lookup)                 │       │
       ▼                              │       │
┌──────────────────┐                  │       │
│  Secrets Manager │◄─────────────────┘       │
│  API key store   │                          │
└──────────────────┘                          │
       │                                      │
       │ queued — caller already got 202      │
       ▼                                      │
┌──────────────────┐                          │
│  SQS Queue       │                          │
│  Buffer + retry  │                          │
└──────┬───────────┘                          │
       │ batches of 10                        │
       ▼                                      │
┌──────────────────────┐                      │
│  Processor Lambda    │                      │
│  Writes both stores  │                      │
└──────┬───────────────┘                      │
       │                                      │
       ├──────────────►┌──────────────────┐   │
       │               │  DynamoDB        │◄──┘ query
       │               │  Fast lookups    │
       │               └──────────────────┘
       │
       └──────────────►┌──────────────────┐
                       │  S3 Object Lock  │◄── integrity check
                       │  7-yr vault      │
                       └──────────────────┘
```

**The key insight:** the queue in the middle is what makes the system fast for callers. Your application gets an instant "received" (HTTP 202) without waiting for the database writes to complete. If something goes wrong on the storage side, the queue retries automatically — up to 5 times before raising an alarm.

---

## 1. PII hashing before any network call

**In plain terms:** personal data — CVs, names, user inputs — is scrambled into a short fingerprint *inside your application* before anything is sent over the internet. The fingerprint cannot be reversed. Only the fingerprint travels.

**Architecture says:**
> PII hashed locally — only hashes + decision JSON leave customer

**Code (`hashing.mjs`):**
```js
export function hashPii(raw) {
  return createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

export function hashPrompt(prompt) {
  return hashPii(prompt);
}
```

Both `rawUserInput` and `rawSystemPrompt` are hashed inside `logDecisionAsync` before the `fetch` call fires. The SHA-256 digest produces a 64-character hex string — enough to prove two records match without revealing what the original said. Raw text never leaves the calling process. This is what makes the GDPR data minimisation claim defensible.

---

## 2. Ingest endpoint and authentication

**In plain terms:** every request knocks on the same door and must show its key. No key, no entry.

**Architecture says:**
> HTTPS POST /audit/events  
> x-api-key: \<tenant key\>

**Code (`index.mjs`):**
```js
const res = await fetchImpl(ingestUrl.replace(/\/$/, ''), {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-api-key': tenantApiKey,
  },
  body: JSON.stringify(payload),
});
```

The tenant API key travels in the `x-api-key` request header — exactly what the Ingest Lambda reads on arrival. The key also appears in the payload body (`tenant_api_key`) so the Lambda can stamp the record with the right tenant ID, but it strips that field before enqueuing so the raw key never reaches storage.

---

## 3. Payload schema

**In plain terms:** every audit event must include the same set of fields — a unique ID, a timestamp, which model was used, fingerprints of the prompt and input, what the AI decided, and whether a human reviewed it.

**Architecture requires:**

| Field | What it is |
|---|---|
| `event_id` | Unique ID for this event (UUID v4) |
| `timestamp` | When it happened (ISO 8601) |
| `model_version` | Which AI model made the decision |
| `system_prompt_hash` | SHA-256 fingerprint of the system prompt |
| `input_data_hash` | SHA-256 fingerprint of the user's input |
| `ai_decision_output` | The actual decision the AI made |
| `human_in_loop` | Whether a human also reviewed this |

**Code (`index.mjs`):**
```js
const payload = {
  event_id:            eventId ?? randomUUID(),       // auto-generated if not supplied
  timestamp:           utcIso(),                      // milliseconds stripped for clean ISO 8601
  tenant_api_key:      tenantApiKey,                  // stripped server-side before storage
  model_version:       modelVersion,
  system_prompt_hash:  hashPrompt(rawSystemPrompt),   // SHA-256 hex — never the raw prompt
  input_data_hash:     hashPii(rawUserInput),         // SHA-256 hex — never the raw input
  ai_decision_output:  aiDecisionOutput,
  human_in_loop:       humanInLoop,
};
```

`randomUUID()` from Node's built-in `crypto` module guarantees a valid UUID v4. `utcIso()` strips milliseconds (`.replace(/\.\d{3}Z$/, 'Z')`) — a deliberate choice not documented in the architecture spec but consistent with it.

---

## 4. Fire-and-forget vs awaited ingest

**In plain terms:** you can either wait for confirmation that the ledger received your event, or fire it off and keep going. Both are valid — it depends on how critical it is to know the log was accepted.

**Architecture says:**
> SendMessage (202 returned to customer)

The 202 is intentional. The SQS queue between the Ingest Lambda and the Processor means the server acknowledges receipt before the database writes happen. The SDK gives you the same choice at the call site:

**Wait for confirmation (`logDecisionAsync`):**
```js
await logDecisionAsync({ ingestUrl, tenantApiKey, ... });
```
Throws an `AuditLedgerError` on failure, with a `.status` property so you can handle a 429 differently from a 503. Use this when a missed audit log should be a hard error.

**Send and move on (`scheduleLogDecision`):**
```js
scheduleLogDecision({ ingestUrl, tenantApiKey, ... });
// your code continues immediately
```
Uses a cross-runtime `defer` helper (`setImmediate` in Node, `setTimeout(0)` in browsers and edge runtimes) to push the network call to the next macrotask. Failures go to `console.error` rather than crashing anything. Use this on hot paths where audit logging must never slow down a user-facing response.

---

## 5. What the SDK does not handle

The SDK is intentionally thin — hash, sign with key, POST. All durability and compliance guarantees live server-side:

| Concern | Where it lives |
|---|---|
| Rate limiting (100 req/min per tenant) | Ingest Lambda + DynamoDB RateLimitTable |
| Payload schema validation | Ingest Lambda |
| Queuing and retry (up to 5×) | SQS + dead-letter queue |
| Writing to fast storage | Processor Lambda → DynamoDB |
| Writing to tamper-proof vault | Processor Lambda → S3 Object Lock |
| Tamper-evidence check | Read Lambda (compares DynamoDB vs S3 copies) |
| Key rotation | Secrets Manager + Lambda cache invalidation |

---

## 6. Mitigations implemented

Four gaps in the original SDK were identified and addressed in `index.mjs`.

### Retry with exponential backoff

**The problem:** if the POST fails — flaky network, server hiccup — the original SDK gave up immediately. Any caller using `scheduleLogDecision` would silently drop the event with no second attempt.

**The fix:** `withRetry` wraps each fetch attempt. On failure it waits, then tries again — up to 3 times by default. The waiting time doubles with each attempt (`baseMs * 2^i`) and adds a random offset called jitter, so that if many clients fail at the same moment they don't all retry in lockstep and overwhelm a recovering server.

Crucially, only network errors and 5xx server errors trigger a retry. A 4xx response (including 429 rate-limited) is returned immediately — retrying those would just waste quota.

```js
const res = await withRetry(
  () => fetchImpl(url, { ... }),
  retries,   // default 3; set to 1 to disable
);
```

### Per-attempt timeout

**The problem:** if the server accepted the TCP connection but then went silent, the original SDK would hang indefinitely with no way to recover — quietly freezing background logging for the whole application.

**The fix:** each attempt gets its own `AbortController` with a 5-second clock. If nothing comes back in time, the request is cancelled and the retry loop takes over (or gives up cleanly after all attempts are exhausted). The timer is always cleared in `.finally()` so it never leaks across attempts.

```js
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
return fetchImpl(url, { signal: controller.signal, ... })
  .finally(() => clearTimeout(timer));
```

### Cross-runtime defer

**The problem:** `scheduleLogDecision` used `setImmediate` to push the network call to the next event loop tick — a Node.js-only API that does not exist in browsers, Cloudflare Workers, Deno, or Bun. Deploying to any of those runtimes would crash at the call site.

**The fix:** the right deferral mechanism is detected once at module load time and used everywhere. No changes needed at call sites.

```js
const defer = typeof setImmediate === 'function'
  ? (fn) => setImmediate(fn)
  : (fn) => setTimeout(fn, 0);
```

### Named error type

**The problem:** failures threw a plain `Error` with the HTTP status code buried in the message string. To handle a 429 differently from a 503, callers had to parse text — fragile and easy to break if the message ever changed.

**The fix:** `AuditLedgerError` is a named subclass with a `.status` property. Network failures and timeouts set `.status` to `null`; HTTP failures carry the actual status code. Callers can now branch on type and status cleanly:

```js
catch (err) {
  if (err instanceof AuditLedgerError && err.status === 429) {
    // rate limited — back off and try later
  }
  if (err instanceof AuditLedgerError && err.status === null) {
    // network or timeout — check connectivity
  }
}
```
