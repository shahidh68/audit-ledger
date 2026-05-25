# AI Audit Ledger — Tenant Integration Guide

This guide covers everything you need to start sending audit records and verifying they have been saved. No AWS access is required — all interaction is via the API.

---

## Contents

1. [What you have been given](#1-what-you-have-been-given)
   - [Your dashboard](#1a-your-dashboard)
2. [How integration works](#2-how-integration-works)
3. [Sending an audit event](#3-sending-an-audit-event)
4. [Checking an event was saved](#4-checking-an-event-was-saved)
5. [Event ID rules — important](#5-event-id-rules--important)
6. [Rate limits](#6-rate-limits)
7. [Error codes and what they mean](#7-error-codes-and-what-they-mean)
8. [Testing your integration](#8-testing-your-integration)
9. [Payload reference](#9-payload-reference)
10. [Code examples](#10-code-examples)

---

## 1. What you have been given

When your account was set up, your account manager provided the following. All keys are generated and issued by the system administrator — you do not create them yourself.

| Item | Example | Notes |
|---|---|---|
| **Ingest URL** | `https://xxxx.execute-api.eu-west-1.amazonaws.com/prod/audit/events` | Where you POST audit records |
| **API Base URL** | `https://xxxx.execute-api.eu-west-1.amazonaws.com/prod` | Used for the dashboard and status checks |
| **Ingest API Key** | `a1b2c3d4e5f6...` | 32-character key — used by your application to submit events |
| **Dashboard Read Key** | `z9y8x7w6v5u4...` | Separate 32-character key — used to log in to the dashboard and view your records |
| **Tenant ID** | `acme-hr` | Your short identifier in the system — you do not send this yourself, it is resolved from your API key |

> **Both keys are provided by your account manager.** If you have not received your Dashboard Read Key, or if you need it rotated, contact your account manager. Do not attempt to generate keys yourself.

Store both keys in a secrets manager or password manager. Never hard-code them in source code or send them in plain email.

---

## 1a. Your dashboard

You have access to a hosted dashboard where you can browse, search, and verify the integrity of your audit records. This is your window into the ledger without needing any technical tools.

**To access your dashboard:**

1. Open the dashboard URL provided by your account manager in any browser
2. Enter your **API Base URL** in the first field
3. Enter your **Dashboard Read Key** in the second field
4. Click **Connect**

You will see all audit records submitted under your account. Each record shows:
- The event ID, timestamp, and model version
- The AI decision output
- An **integrity check** — a green tick means the record matches the original sealed copy in the archive and has not been tampered with

> **Your dashboard read key shows only your records.** You cannot see any other tenant's data, and they cannot see yours.

If the integrity check shows a failure on any record, contact your account manager immediately with the event ID. Do not delete or modify anything.

---

## 2. How integration works

Once your developers have integrated the API, the audit process is **fully automatic** — no manual steps are needed after the initial setup.

Every time your application makes an AI decision, it calls the audit API in the background before moving on. Your users and your own workflows are not affected.

```
User triggers an action in your application
            ↓
Your application calls the AI model
            ↓
AI model returns a decision
            ↓
Your application automatically calls sendAuditEvent(...)
            ↓
Audit record is accepted (202) and saved to the tamper-evident ledger
            ↓
Your application continues normally
```

**The manual curl commands in the Testing section are only for initial setup verification.** In production your code handles everything.

---

### What your developers integrate

A single function call after each AI decision:

```python
# Python example — called automatically after every model invocation
# API key and URL are read from environment variables, not stored in code
event_id = send_audit_event(
    model_version   = "gpt-4o",
    system_prompt   = system_prompt_text,
    input_data      = user_input_text,
    decision        = model_response,
    human_in_loop   = False,
)
# Store event_id in your own database alongside your record
```

```javascript
// Node.js example — API key and URL are read from environment variables
const eventId = await sendAuditEvent({
  modelVersion:  'gpt-4o',
  systemPrompt:  systemPromptText,
  inputData:     userInputText,
  decision:      modelResponse,
  humanInLoop:   false,
});
// Store eventId in your own database alongside your record
```

Full working implementations are in [Section 10](#10-code-examples).

---

### Storing the event_id

Your application should save the returned `event_id` alongside your own record (in your database, your logs, or your case management system). This gives you a direct link from your internal records to the audit ledger entry, so you can look up any decision at any time using the status endpoint.

---

### Background confirmation (optional but recommended)

Rather than waiting for the status check to complete before continuing, most integrations run it asynchronously:

1. Send the audit event → get `event_id` back immediately
2. Continue with your normal application flow
3. A background job polls the status endpoint after a few seconds to confirm `saved: true`
4. If `saved` is still `false` after 2 minutes, raise an internal alert with the `event_id`

This keeps your application fast while still giving you confidence that every record reached permanent storage.

---

## 3. Sending an audit event

**Endpoint**
```
POST {IngestUrl}
```

**Required headers**
```
Content-Type: application/json
x-api-key: YOUR_API_KEY
```

**Minimum required body**

> **Important:** `event_id` must be a UUID v4 string (e.g. `550e8400-e29b-41d4-a716-446655440000`). Plain strings such as `test-001` or `evt-123` will be rejected with a `400` error. Always generate it using your language's UUID library — see Section 5 for examples.

```json
{
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-04-14T10:00:00Z",
  "model_version": "gpt-4o",
  "system_prompt_hash": "sha256 hex of the system prompt",
  "input_data_hash": "sha256 hex of the input data",
  "ai_decision_output": { "decision": "approved", "score": 87 },
  "human_in_loop": false
}
```

**Success response — 202 Accepted**
```json
{
  "message": "Accepted",
  "event_id": "the event_id you sent"
}
```

A `202` means the record has been accepted and queued. It will be written to the permanent audit ledger within a few seconds. The response also includes two headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 97
```

These tell you how many requests you have left in the current one-minute window.

---

## 3. Checking an event was saved

After sending an event you can confirm it reached permanent storage by polling the status endpoint.

**Endpoint**
```
GET {ApiBaseUrl}audit/events/{event_id}/status
```

**Required headers**
```
x-api-key: YOUR_API_KEY
```

**Response — event saved**
```json
{
  "event_id": "your-event-id",
  "saved": true,
  "tenant_id": "acme-hr",
  "timestamp": "2026-04-14T10:00:00Z"
}
```

**Response — not yet saved (or failed)**
```json
{
  "event_id": "your-event-id",
  "saved": false
}
```

`saved: false` means the record has not reached permanent storage yet. This is normal for up to 30 seconds after submission due to the async processing pipeline. If `saved` is still `false` after 2 minutes, the record may have failed — contact support with the `event_id`.

**Recommended polling pattern:**
- Wait 5 seconds after the `202` response
- Poll the status endpoint
- If `saved: false`, retry every 10 seconds for up to 2 minutes
- If still `false` after 2 minutes, raise a support ticket

---

## 4. Event ID rules — important

The `event_id` field is how the system identifies a unique audit record.

**Rules:**
- Must be unique per event — use **UUID v4** (example: `550e8400-e29b-41d4-a716-446655440000`)
- Must be a string
- If you send the same `event_id` twice, the second request will be **rejected with a 409 error** — the original record is preserved unchanged

**Why this matters:**
If your system retries a failed HTTP request, the retry is safe — the duplicate will be rejected and the original record will not be overwritten. You do not need to worry about double-counting on retries.

**How to generate a UUID in common languages:**

```python
# Python
import uuid
event_id = str(uuid.uuid4())
```

```javascript
// Node.js (v14.17+)
import { randomUUID } from 'crypto';
const eventId = randomUUID();
```

```csharp
// C#
string eventId = Guid.NewGuid().ToString();
```

```java
// Java
String eventId = UUID.randomUUID().toString();
```

---

## 5. Rate limits

The default rate limit is **100 requests per minute per tenant**.

If you exceed this limit you will receive a `429 Too Many Requests` response:

```json
{
  "error": "Rate limit exceeded",
  "limit_per_minute": 100
}
```

The response also includes:
```
Retry-After: 60
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
```

Wait 60 seconds before retrying. If your system consistently hits the rate limit, contact your account manager to discuss a higher limit.

---

## 6. Error codes and what they mean

| HTTP Code | Meaning | What to do |
|---|---|---|
| `202 Accepted` | Record accepted and queued | Normal — record will be saved within seconds |
| `400 Bad Request` | Missing or invalid field in the request body | Check the error message — a required field is missing or the wrong type |
| `401 Unauthorized` | API key missing or invalid | Check the `x-api-key` header is present and correct |
| `409 Conflict` | You have already sent this `event_id` | This is a duplicate — your original record is safe, no action needed |
| `429 Too Many Requests` | Rate limit exceeded | Wait 60 seconds and retry |
| `500 Internal Server Error` | Server-side problem | Retry after 30 seconds. If it persists, contact support |
| `502 Bad Gateway` | Temporary queue failure | Retry after 30 seconds |

---

## 7. Testing your integration

Before going live, send a test record and verify it is saved correctly.

**Step 1 — Send a test record**

Replace `YOUR_INGEST_URL` and `YOUR_API_KEY` with your real values.

Using curl (Mac/Linux):
```bash
curl -i -X POST "YOUR_INGEST_URL" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "event_id": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2026-04-14T10:00:00Z",
    "model_version": "test-model-v1",
    "system_prompt_hash": "aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd",
    "input_data_hash": "bbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaa",
    "ai_decision_output": {"decision": "approved", "score": 99},
    "human_in_loop": false
  }'
```

Using PowerShell (Windows):
```powershell
Invoke-RestMethod -Method POST -Uri "YOUR_INGEST_URL" -Headers @{"x-api-key"="YOUR_API_KEY"; "Content-Type"="application/json"} -Body '{"event_id":"550e8400-e29b-41d4-a716-446655440000","timestamp":"2026-04-14T10:00:00Z","model_version":"test-model-v1","system_prompt_hash":"aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd","input_data_hash":"bbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaa","ai_decision_output":{"decision":"approved","score":99},"human_in_loop":false}'
```

You should see `HTTP 202` and `"message": "Accepted"` in the response.

---

**Step 2 — Verify it was saved**

Wait 5 seconds, then check the status:

```bash
curl -i "YOUR_API_BASE_URL/audit/events/550e8400-e29b-41d4-a716-446655440000/status" \
  -H "x-api-key: YOUR_API_KEY"
```

You should see `"saved": true`.

---

**Step 3 — Confirm duplicate rejection**

Send the exact same request again (same `event_id`). You should receive `409 Conflict`. Your original record was not affected.

---

## 8. Payload reference

| Field | Type | Required | Description |
|---|---|---|---|
| `event_id` | string | Yes | Unique identifier you generate (UUID v4 recommended) |
| `timestamp` | string (ISO 8601) | Yes | When the AI decision occurred — `2026-04-14T10:00:00Z` |
| `model_version` | string | Yes | The AI model that made the decision — e.g. `gpt-4o`, `claude-3-5-sonnet` |
| `system_prompt_hash` | string | Yes | SHA-256 hex digest of the system prompt used. 64 characters. |
| `input_data_hash` | string | Yes | SHA-256 hex digest of the input data passed to the model. 64 characters. |
| `ai_decision_output` | object | Yes | The decision or output of the model. Any JSON object. |
| `human_in_loop` | boolean | Yes | Whether a human reviewed this decision before it was acted on |
| `metadata` | object | No | Any additional context you want to store — free-form JSON |

**Notes:**
- Hash fields must be exactly 64 lowercase hexadecimal characters (SHA-256)
- Do not include your raw API key or any personal data in the payload
- The `ai_decision_output` field can be any valid JSON object — there is no schema restriction

---

## 10. Code examples

> **Never put your API key directly in source code.** Store it as an environment variable and read it at runtime. If it is committed to a code repository — even a private one — treat it as compromised and request a key rotation immediately.

---

### Setting your environment variables

**Mac / Linux:**
```bash
export AUDIT_API_KEY="your-api-key-here"
export AUDIT_INGEST_URL="https://xxxx.execute-api.eu-west-1.amazonaws.com/prod/audit/events"
export AUDIT_BASE_URL="https://xxxx.execute-api.eu-west-1.amazonaws.com/prod"
```

**Windows (PowerShell):**
```powershell
$env:AUDIT_API_KEY   = "your-api-key-here"
$env:AUDIT_INGEST_URL = "https://xxxx.execute-api.eu-west-1.amazonaws.com/prod/audit/events"
$env:AUDIT_BASE_URL  = "https://xxxx.execute-api.eu-west-1.amazonaws.com/prod"
```

In production, set these through your platform's secret management — AWS Secrets Manager, Azure Key Vault, GitHub Actions secrets, Kubernetes secrets, etc. Never set them in a `.env` file that is committed to source control.

---

### Python

```python
import os
import uuid
import hashlib
from datetime import datetime, timezone
import httpx  # pip install httpx

INGEST_URL = os.environ["AUDIT_INGEST_URL"]
BASE_URL   = os.environ["AUDIT_BASE_URL"]
API_KEY    = os.environ["AUDIT_API_KEY"]

def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()

def send_audit_event(model_version: str, system_prompt: str, input_data: str, decision: dict, human_in_loop: bool) -> str:
    event_id = str(uuid.uuid4())

    response = httpx.post(
        INGEST_URL,
        headers={"x-api-key": API_KEY, "Content-Type": "application/json"},
        json={
            "event_id":           event_id,
            "timestamp":          datetime.now(timezone.utc).isoformat(),
            "model_version":      model_version,
            "system_prompt_hash": hash_text(system_prompt),
            "input_data_hash":    hash_text(input_data),
            "ai_decision_output": decision,
            "human_in_loop":      human_in_loop,
        },
        timeout=10,
    )
    response.raise_for_status()
    return event_id

def check_saved(event_id: str) -> bool:
    response = httpx.get(
        f"{BASE_URL}/audit/events/{event_id}/status",
        headers={"x-api-key": API_KEY},
        timeout=10,
    )
    return response.json().get("saved", False)
```

---

### Node.js

```javascript
import crypto from 'crypto';

const INGEST_URL = process.env.AUDIT_INGEST_URL;
const BASE_URL   = process.env.AUDIT_BASE_URL;
const API_KEY    = process.env.AUDIT_API_KEY;

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function sendAuditEvent({ modelVersion, systemPrompt, inputData, decision, humanInLoop }) {
  const eventId = crypto.randomUUID();

  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      event_id:           eventId,
      timestamp:          new Date().toISOString(),
      model_version:      modelVersion,
      system_prompt_hash: hashText(systemPrompt),
      input_data_hash:    hashText(inputData),
      ai_decision_output: decision,
      human_in_loop:      humanInLoop,
    }),
  });

  if (!res.ok) throw new Error(`Ingest failed: ${res.status}`);
  return eventId;
}

async function checkSaved(eventId) {
  const res = await fetch(`${BASE_URL}/audit/events/${eventId}/status`, {
    headers: { 'x-api-key': API_KEY },
  });
  const data = await res.json();
  return data.saved === true;
}
```

---

## Support

If you have a record that is not appearing after 2 minutes, or you receive an unexpected error, contact support with:

1. The `event_id` of the affected record
2. The exact HTTP response code and body you received
3. The timestamp when you sent it

Do not share your API key in any support communication. If you believe your key has been compromised, contact us immediately so it can be rotated.
