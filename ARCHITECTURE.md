# AI Audit Ledger — Architecture Reference

This document is the single technical reference for the deployed infrastructure. It covers every AWS component, how they connect, the security model, configuration values, and the reasoning behind key decisions.

For a plain-English explanation see [LAYMAN-GUIDE.md](./LAYMAN-GUIDE.md).  
For deployment steps see [DEPLOYMENT.md](./DEPLOYMENT.md) and [GETTING-STARTED.md](./GETTING-STARTED.md).

---

## 1. System overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Customer systems                                                    │
│  Python SDK / Node SDK                                               │
│  (PII hashed locally — only hashes + decision JSON leave customer)  │
└────────────────────────┬────────────────────────────────────────────┘
                         │ HTTPS POST /audit/events
                         │ x-api-key: <tenant key>
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  API Gateway  (REST, prod stage)                                     │
│  Burst: 200 req   Rate: 100 req/s                                   │
│  CORS: ALL_ORIGINS                                                   │
└──────────┬──────────────────────────────────┬───────────────────────┘
           │ POST /audit/events               │ GET /audit/logs
           │                                  │ GET /audit/events/{id}/history
           ▼                                  ▼
┌──────────────────────┐           ┌──────────────────────┐
│  Lambda: Ingest      │           │  Lambda: Read        │
│  Runtime: Node 20    │           │  Runtime: Node 20    │
│  Memory:  256 MB     │           │  Memory:  512 MB     │
│  Timeout: 10 s       │           │  Timeout: 30 s       │
│  Logs:    1 week     │           │  Logs:    1 week     │
└──────┬───────────────┘           └──────┬───────┬───────┘
       │                                  │       │
       │ Reads                            │ Query │ GetObject
       ▼                                  │       │
┌──────────────────┐                      │       │
│  Secrets Manager │◄─────────────────────┘       │
│  tenant-key-map  │  read-key-map                 │
└──────────────────┘                              │
       │                                          │
       │ SendMessage (202 returned to customer)   │
       ▼                                          │
┌──────────────────┐                             │
│  SQS: IngestQueue│                             │
│  Visibility: 120s│                             │
│  DLQ after 5 fails│                            │
└──────┬───────────┘                             │
       │                                         │
       │ Batch 10                                │
       ▼                                         │
┌──────────────────────┐                        │
│  Lambda: Processor   │                        │
│  Runtime: Node 20    │                        │
│  Memory:  512 MB     │                        │
│  Timeout: 60 s       │                        │
│  Concurrency: 10     │                        │
└──────┬───────────────┘                        │
       │                                        │
       ├──── PutItem ──────►┌──────────────────┐│
       │                    │  DynamoDB        ││
       │                    │  Audit table     │◄┘  (Query by tenant_id/date)
       │                    │  PK: tenant_id   │
       │                    │  SK: ts#event_id │
       │                    │  GSI: event_id   │
       │                    └──────────────────┘
       │
       └──── PutObject ────►┌──────────────────┐
                            │  S3 Object Lock  │◄── (GetObject — integrity check)
                            │  COMPLIANCE mode │
                            │  Retention: 7 yr │
                            │  Versioned: true │
                            │  Encrypted: SSE  │
                            │  Public: BLOCKED │
                            └──────────────────┘

┌──────────────────┐
│  DynamoDB        │◄── ADD count :one (atomic)
│  Rate limit table│    PK: tenant_id#minuteWindow
│  TTL: 2 min      │    TTL auto-expires entries
└──────────────────┘
```

---

## 2. Component inventory

### API Gateway

| Property | Value |
|---|---|
| Type | REST API |
| Stage | `prod` |
| Burst limit | 200 concurrent requests |
| Rate limit | 100 requests/second |
| Logging | ERROR level |
| Metrics | Enabled |
| CORS | All origins, all methods |

**Routes:**

| Method | Path | Lambda | Auth |
|---|---|---|---|
| POST | `/prod/audit/events` | Ingest | Tenant API key (header `x-api-key`) |
| GET | `/prod/audit/logs` | Read | Read API key (header `x-api-key`) |
| GET | `/prod/audit/events/{eventId}/history` | Read | Read API key (header `x-api-key`) |

---

### Lambda: Ingest

| Property | Value |
|---|---|
| Runtime | Node.js 20.x |
| Memory | 256 MB |
| Timeout | 10 seconds |
| Log retention | 1 week |

**Environment variables:**

| Variable | Value |
|---|---|
| `QUEUE_URL` | SQS IngestQueue URL |
| `TENANT_KEY_SECRET_ARN` | Secrets Manager ARN for tenant key map |
| `RATE_LIMIT_TABLE` | DynamoDB rate limit table name |
| `RATE_LIMIT_PER_MINUTE` | Default: `100` (configurable via CDK context) |

**IAM permissions:**
- `sqs:SendMessage` on IngestQueue
- `secretsmanager:GetSecretValue` on TenantKeyMapSecret
- `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:UpdateItem` on RateLimitTable

**Behaviour:**
1. Reads tenant API key from `x-api-key` header
2. Fetches tenant key map from Secrets Manager (cached in Lambda memory; invalidates on miss for key rotation)
3. Checks per-tenant rate limit via DynamoDB atomic counter (`tenant_id#minuteWindow`)
4. Validates payload schema (UUID v4 event_id, ISO 8601 timestamp, SHA-256 hashes, etc.)
5. Strips any `tenant_api_key` field from the payload
6. Enqueues to SQS and returns `202 Accepted`
7. Returns `429` with `Retry-After: 60` and `X-RateLimit-*` headers if rate exceeded

---

### Lambda: Processor

| Property | Value |
|---|---|
| Runtime | Node.js 20.x |
| Memory | 512 MB |
| Timeout | 60 seconds |
| Log retention | 1 week |
| Reserved concurrency | 10 |
| Trigger | SQS IngestQueue, batch size 10 |

**Environment variables:**

| Variable | Value |
|---|---|
| `AUDIT_TABLE` | DynamoDB audit table name |
| `AUDIT_BUCKET` | S3 audit bucket name |
| `RETENTION_YEARS` | Default: `7` (configurable via CDK context) |

**IAM permissions:**
- `dynamodb:PutItem` on AuditTable
- `s3:PutObject` on AuditBucket

**Behaviour:**
1. Receives batches of up to 10 messages from SQS
2. For each message:
   - Strips `_ingested_at` pipeline field
   - Writes to DynamoDB with `ConditionExpression: attribute_not_exists(sk)` (idempotent on SQS retry)
   - Writes to S3 with `ObjectLockMode: COMPLIANCE` and retention date = now + `RETENTION_YEARS` years
3. S3 key format: `{tenant_id}/{event_id}.json`
4. DynamoDB sort key format: `{timestamp}#{event_id}` (lexicographic sort = chronological order)

---

### Lambda: Read

| Property | Value |
|---|---|
| Runtime | Node.js 20.x |
| Memory | 512 MB |
| Timeout | 30 seconds |
| Log retention | 1 week |

**Environment variables:**

| Variable | Value |
|---|---|
| `AUDIT_TABLE` | DynamoDB audit table name |
| `AUDIT_BUCKET` | S3 audit bucket name |
| `READ_KEY_SECRET_ARN` | Secrets Manager ARN for read key map |

**IAM permissions:**
- `dynamodb:Query`, `dynamodb:Scan`, `dynamodb:GetItem` on AuditTable and event_id-index GSI
- `s3:GetObject` on AuditBucket
- `secretsmanager:GetSecretValue` on ReadKeyMapSecret

**Behaviour — list (`GET /audit/logs`):**
- Tenant caller: `Query` on `tenant_id` partition key, SK between `{from}#` and `{to}~`
- Admin caller (`"*"`): `Scan` with optional timestamp filter
- Returns items sorted newest first, `sk` field stripped from response

**Behaviour — tamper-evidence check (`GET /audit/events/{eventId}/history`):**
1. Queries DynamoDB `event_id-index` GSI to find the record
2. Enforces tenant scope (non-admin cannot access another tenant's records)
3. Fetches original from S3 at `{tenant_id}/{event_id}.json`
4. Compares both copies with stable JSON serialisation (sorted keys)
5. Returns `integrity_verified: true/false` with both records and a plain-English note

---

### SQS: IngestQueue

| Property | Value |
|---|---|
| Visibility timeout | 120 seconds (matches processor timeout) |
| Dead-letter queue | IngestDLQ after 5 failed receive attempts |
| DLQ retention | 14 days |

---

### DynamoDB: AuditTable

| Property | Value |
|---|---|
| Billing | PAY_PER_REQUEST (on-demand) |
| Partition key | `tenant_id` (String) |
| Sort key | `sk` (String) — format: `{ISO timestamp}#{event_id}` |
| Point-in-time recovery | Enabled |
| Removal policy | RETAIN |

**Global Secondary Index: `event_id-index`**

| Property | Value |
|---|---|
| Partition key | `event_id` (String) |
| Projection | ALL |

Purpose: direct lookup by event ID without knowing the tenant. Used by the history/tamper-check endpoint.

---

### DynamoDB: TenantSequenceTable

| Property | Value |
|---|---|
| Billing | PAY_PER_REQUEST |
| Partition key | `tenant_id` (String) |
| Attributes | `current_sequence` (Number), `updated_at` (String, ISO 8601) |
| Point-in-time recovery | Enabled |
| Removal policy | RETAIN |

**Item shape:** `{ tenant_id, current_sequence: <integer>, updated_at: <ISO timestamp> }`

**How sequence allocation works:** Each successful audit record receives a per-tenant monotonic `sequence_no`. The processor atomically increments `current_sequence` via `UpdateItem` with `ADD current_sequence :one` and `ReturnValues: 'UPDATED_NEW'`, then stamps the returned value onto the audit row before writing to DynamoDB and S3. The read Lambda inspects this table (read-only) when answering `verify_completeness` without an explicit upper bound, to know the highest sequence number that should exist.

**Why RETAIN:** Losing this counter would reset future allocations to 1 and create spurious gaps the verify-completeness endpoint would report as missing records. RETAIN ensures a stack teardown does not destroy it; point-in-time recovery covers accidental in-place damage.

**Why a separate table rather than reusing AuditTable:** The counter is a different access pattern (atomic increment per tenant) and a different semantic concern (allocation, not storage). Mixing it with audit data would muddy IAM scoping — only the processor writes here, but everything writes to AuditTable.

---

### DynamoDB: RateLimitTable

| Property | Value |
|---|---|
| Billing | PAY_PER_REQUEST |
| Partition key | `pk` (String) — format: `{tenant_id}#{minuteWindow}` |
| TTL attribute | `ttl` (auto-expires entries after 2 minutes) |
| Removal policy | DESTROY |

**How rate limiting works:** The ingest Lambda performs an atomic `ADD count :one` on the counter for the current minute window. If the returned count exceeds `RATE_LIMIT_PER_MINUTE`, the request is rejected with 429. TTL ensures old windows clean up automatically.

---

### S3: AuditBucket

| Property | Value |
|---|---|
| Object Lock | Enabled |
| Lock mode (per object) | COMPLIANCE |
| Retention period | `RETENTION_YEARS` years from write time (default 7) |
| Versioning | Enabled (required for Object Lock) |
| Encryption | SSE-S3 (server-side encryption) |
| Public access | Blocked entirely |
| Removal policy | RETAIN |

**Object key format:** `{tenant_id}/{event_id}.json`

**Why COMPLIANCE mode:** In COMPLIANCE mode, no AWS user — including the root account — can delete or overwrite an object before its retention date. This is the strongest available guarantee and the standard used for SEC 17a-4, FINRA, and HIPAA regulatory archives. It is what makes the tamper-evidence claim defensible to a regulator.

---

### Secrets Manager

Two secrets, both with `RETAIN` removal policy:

| Secret name | Contents | Used by |
|---|---|---|
| `ai-audit-ledger/tenant-key-map` | JSON: `{ "api-key": "tenant-id" }` | Ingest Lambda |
| `ai-audit-ledger/read-key-map` | JSON: `{ "read-key": "tenant-id-or-*" }` | Read Lambda |

**Key rotation:** Update the secret value in AWS Console. Both Lambdas cache the map in memory and invalidate the cache on a key miss, so rotation takes effect within seconds without redeployment.

**Admin access:** A read key mapped to `"*"` grants access to all tenants' records.

---

## 3. Security model

### Authentication

- All API calls require an `x-api-key` header
- Keys are never stored in environment variables, config files, or CloudFormation outputs
- Keys live exclusively in Secrets Manager and are fetched at Lambda runtime
- Two separate key namespaces: tenant keys (write-only) and read keys (read-only)

### Authorisation

- Tenants can only write; they cannot read any records via the ingest endpoint
- Read keys are scoped: a tenant read key only returns that tenant's records
- Admin read key (`"*"`) returns all tenants' records — intended for internal use only
- The processor Lambda has no read permissions on the audit data

### Data minimisation

- Raw PII (names, CVs, identifiers) is hashed by the SDK before sending. By default the SDK uses HMAC-SHA256 keyed off a per-tenant secret (`AUDIT_HMAC_KEY`) held in the tenant's environment, so the digest is not reversible without that key
- The API stores hashes, decision outputs, and metadata, not raw personal data
- This supports GDPR data minimisation obligations and aligns with ICO/EDPB expectations for pseudonymisation rather than plain unsalted hashing

#### The HMAC key flow (who generates, who holds, what travels)

The PII hashing design relies on a single principle: the secret used to compute the hash must be held by the tenant, not by the ledger operator. If the operator held the key, the operator could reverse the hash, and the digest would still be personal data under ICO/EDPB guidance. Putting the key in the tenant's environment is what changes the legal characterisation of the digest from "fingerprint of personal data" to "pseudonymised value."

The lifecycle has four steps:

1. **Generation.** The tenant's operator runs a one-time command on their own machine to produce a 32-byte random secret. The SDKs ship with the recommended commands (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` or `python -c "import secrets; print(secrets.token_hex(32))"`). The ledger operator is not involved.

2. **Storage.** The tenant stores the secret wherever they already keep `AUDIT_WRITE_KEY`: an environment variable, a `.env` file under restricted permissions, AWS Secrets Manager, HashiCorp Vault, or equivalent. The variable name the SDK and the MCP server read is `AUDIT_HMAC_KEY`. The secret never leaves the tenant's infrastructure.

3. **Hashing at the SDK or MCP.** When a tenant application calls `record_decision`, the SDK or MCP reads `AUDIT_HMAC_KEY` from the environment and computes `HMAC-SHA256(key, raw_pii)` to produce a 64-character hex digest. That digest is what becomes `input_data_hash` and `system_prompt_hash` in the outgoing payload. The raw PII and the key both stay in the tenant's process memory and are never serialised into a request.

4. **Storage and verification at the ledger.** The ledger stores the digest in both DynamoDB and S3 Object Lock. Tamper verification compares the two stored copies of the digest and does not need the key. The ledger cannot reverse the digest because it has never seen the key.

The fallback path exists for backwards compatibility with the v0.2 plain-SHA-256 behaviour. If `AUDIT_HMAC_KEY` is not set, the SDKs and the MCP fall back to plain SHA-256 and emit a one-time deprecation warning. Existing integrations keep working unchanged but lose the regulatory characterisation. The warning makes the silent downgrade observable.

The rotation tradeoff is real and worth being explicit about. Forward-only rotation is fine for tamper verification because the ledger compares stored digests against stored digests. It does not work for searching across the rotation boundary using the same PII value, because that value now hashes to a different digest under the new key. Tenants who need historical PII lookups keep the old key alongside the new one and search with both. There is no scheme inside the ledger that re-keys old hashes, by design — re-keying would require the ledger operator to know either the old or new key, which would defeat the property the change is meant to preserve.

#### How the customer presents the key to each client type

The SDKs and the MCP server all read `AUDIT_HMAC_KEY` from the process environment at hash time. The mechanism for putting it there depends on which client surface the customer is using. None of these involve sending the key over the network. None of them require the customer to share the key with the ledger operator.

**Python SDK.** Set the environment variable in whatever way the host Python process is launched:

```bash
export AUDIT_HMAC_KEY="<your-tenant-hmac-secret>"
python your_app.py
```

Or load from `.env` with `python-dotenv`. Or read from AWS Secrets Manager / HashiCorp Vault and inject via the deployment platform's secret manager (e.g. ECS task definition, Kubernetes secret, Lambda environment).

**Node SDK.** Same pattern:

```bash
export AUDIT_HMAC_KEY="<your-tenant-hmac-secret>"
node your_app.js
```

Or via `dotenv`, or via the host platform's secret injection.

**MCP server, Claude Desktop.** The `env` block inside the `mcpServers` entry in `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "audit-ledger": {
      "command": "npx",
      "args": ["-y", "audit-ledger-mcp"],
      "env": {
        "AUDIT_API_URL":   "https://<api-id>.execute-api.<region>.amazonaws.com/prod",
        "AUDIT_WRITE_KEY": "<your-tenant-write-key>",
        "AUDIT_READ_KEY":  "<your-tenant-read-key>",
        "AUDIT_HMAC_KEY":  "<your-tenant-hmac-secret>"
      }
    }
  }
}
```

When Claude Desktop spawns the MCP server, it injects this `env` block into the child process. The MCP server then sees `process.env.AUDIT_HMAC_KEY`.

**MCP server, Cursor.** Same JSON shape inside Cursor's MCP settings panel.

**MCP server, LangGraph (Python via `langchain-mcp-adapters`).** The `env` dict on the `MultiServerMCPClient` server entry:

```python
client = MultiServerMCPClient({
    "audit-ledger": {
        "command": "npx",
        "args": ["-y", "audit-ledger-mcp"],
        "transport": "stdio",
        "env": {
            "AUDIT_API_URL":   os.environ["AUDIT_API_URL"],
            "AUDIT_WRITE_KEY": os.environ["AUDIT_WRITE_KEY"],
            "AUDIT_READ_KEY":  os.environ["AUDIT_READ_KEY"],
            "AUDIT_HMAC_KEY":  os.environ["AUDIT_HMAC_KEY"],
        },
    }
})
```

Note the pattern: the LangGraph host process reads `AUDIT_HMAC_KEY` from its own environment, then passes it explicitly to the spawned MCP child. The host's environment is itself populated however the deploying team does that (Vault, ECS secret, plain `export`, etc.).

**MCP server, direct shell.** Pass it inline when spawning:

```bash
AUDIT_API_URL=... AUDIT_WRITE_KEY=... AUDIT_READ_KEY=... AUDIT_HMAC_KEY=... npx -y audit-ledger-mcp
```

This is mostly used for development and CI smoke tests. Production usage goes through one of the above client paths.

**Containerised deployment.** Set the environment variable in the container spec. For example, a Kubernetes Deployment manifest with `envFrom: secretRef` pointing at a Kubernetes Secret that the platform team rotates separately. The hashing logic is unchanged: the SDK or MCP process reads `process.env.AUDIT_HMAC_KEY` exactly as in the bare-shell case.

**What does not work**

The MCP protocol has no mechanism for the client to pass a secret to the server during an MCP `initialize` handshake. The server must already have the key in its environment by the time the client connects. This is by design: secrets travelling through the MCP protocol would be visible to whatever intermediary layer was forwarding the protocol traffic, which defeats the customer-holds-the-key property. If a future MCP client adds a "pass this secret to the server" feature, the customer should not use it for `AUDIT_HMAC_KEY`. The env block is the right place.

#### Three implementations, not one shared library

The HMAC logic exists three times in the codebase, in three different languages, in two different repos:

| Implementation | Repo | File | Language |
|---|---|---|---|
| Python SDK | `ai-audit-ledger` | `sdk/python/ai_audit_ledger/hashing.py` | Python |
| Node SDK | `ai-audit-ledger` | `sdk/nodejs/src/hashing.mjs` | JavaScript |
| MCP server | `audit-ledger-mcp` | `src/hashing.ts` | TypeScript |

These are not three thin wrappers around a shared library. Each is a self-contained implementation of `HMAC-SHA256(env.AUDIT_HMAC_KEY, input).hexdigest()` with a plain-SHA-256 fallback when the env var is unset.

**Why no shared library:**

- The MCP server has to be its own published npm package because MCP clients spawn it as `npx audit-ledger-mcp` over stdio. It cannot import from the SDK repo at runtime.
- The Python SDK is imported into customer Python applications via PyPI. Customers do not want a Python package that depends on a Node package or vice versa.
- A shared hashing library would need to be a fourth published package that all three consumers depend on. That introduces a release-coupling problem: bumping the shared library would require coordinated releases across three downstream packages, and a stale consumer would silently use an older hashing implementation than the others.

The cost of three implementations is duplicate code that must stay in sync. The mitigation is enforced parity through unit tests: each implementation asserts its output against the canonical `HMAC-SHA256(key, input).hex()` computed inline using its language's standard library. Drift in any single implementation fails CI on that repo immediately. Cross-repo drift would be caught when the customer runs end-to-end and gets different digests for the same input. In practice the tests catch it first.

**One pre-existing wire-format quirk:**

The MCP server's `hashPrompt` normalises whitespace (runs of whitespace collapsed to single spaces, leading/trailing whitespace trimmed) before hashing. The SDKs' `hashPrompt` does not. This means that for a prompt with internal whitespace variation, `system_prompt_hash` computed via the MCP server will differ from `system_prompt_hash` computed via the Python or Node SDK, even with the same `AUDIT_HMAC_KEY`. For prompts without internal whitespace variation (which is the overwhelming majority of cases), the hashes are identical.

This quirk predates v0.3. It exists because the MCP server is most commonly used in interactive contexts (Claude Desktop, Cursor) where prompts get reformatted by the host application, and the normalisation was added to keep prompt-fingerprint tracking stable across cosmetic edits. Fixing the divergence is a wire-format change, which is deferred until a v1.0 wire-format consolidation pass. The `hashPii` function (used for `input_data_hash`) is identical across all three implementations and produces identical output for identical input.

### Immutability

- Every record is written to S3 with Object Lock COMPLIANCE mode
- COMPLIANCE mode prevents deletion or modification by any AWS principal until the retention date
- Retention is set per-object at write time to `now + RETENTION_YEARS`

### Network

- All traffic is over HTTPS (TLS enforced by API Gateway)
- S3 bucket blocks all public access
- Lambda functions run in the default AWS-managed VPC (no custom VPC required at this scale)

---

## 4. Data flow

### Ingest path (happy path)

```
1. Customer SDK hashes PII locally
2. POST /audit/events with x-api-key and JSON payload
3. API Gateway → Ingest Lambda
4. Ingest Lambda:
   a. Fetch tenant key map from Secrets Manager (or cache)
   b. Validate API key → resolve tenant_id
   c. Check rate limit (DynamoDB atomic increment)
   d. Validate payload schema
   e. Add tenant_id, strip tenant_api_key
   f. SendMessage to SQS
   g. Return 202 Accepted
5. SQS delivers batch to Processor Lambda
6. Processor Lambda:
   a. Pre-flight Query on event_id-index — skip if event already stored with sequence_no (SQS redelivery idempotency)
   b. UpdateItem on TenantSequenceTable — atomically allocate next sequence_no for tenant
   c. PutItem to DynamoDB with sequence_no included, idempotent condition on sk
      - On ConditionalCheckFailed (rare race): log sequence_burned event, abort, do not write S3
   d. PutObject to S3 with COMPLIANCE lock and retention date, sequence_no embedded in JSON body
```

### Read path (list)

```
1. GET /audit/logs?from=2026-01-01T00:00:00Z&to=2026-03-31T23:59:59Z
2. API Gateway → Read Lambda
3. Read Lambda:
   a. Fetch read key map from Secrets Manager (or cache)
   b. Validate read key → resolve caller tenant_id
   c. If tenant: Query DynamoDB PK=tenant_id, SK between from# and to~
   d. If admin: Scan DynamoDB with timestamp filter
   e. Strip sk field, sort newest first
   f. Return items array
```

### Read path (tamper-evidence check)

```
1. GET /audit/events/{eventId}/history
2. API Gateway → Read Lambda
3. Read Lambda:
   a. Validate read key
   b. Query DynamoDB event_id-index GSI for event_id
   c. Enforce tenant scope
   d. GetObject from S3: {tenant_id}/{event_id}.json
   e. Serialise both copies with sorted keys
   f. Compare → integrity_verified: true/false
   g. Return both records + integrity note
```

### Read path (completeness check)

```
1. GET /audit/verify-completeness?from=<seq>&to=<seq>
2. API Gateway → Read Lambda
3. Read Lambda:
   a. Validate read key, resolve tenant_id
   b. Query DynamoDB PK=tenant_id, projection on sequence_no only
      - Paginates if tenant has many records
   c. GetItem on TenantSequenceTable for current counter value
   d. resolveRange clamps from/to to [1, counter]
   e. computeCompleteness returns missing sequence numbers
   f. Return { tenant_id, range, expected_count, found_count, missing, note }
```

This path is what answers the regulatory question "can you prove the log is complete?" Tamper-checking answers "is this record unchanged?" — completeness checking answers "is every record we expected actually present?" The two together cover both the alteration and the omission failure modes.

---

## 5. Payload schema

### Ingest request body

| Field | Type | Validation |
|---|---|---|
| `event_id` | string | UUID v4 |
| `timestamp` | string | ISO 8601 |
| `model_version` | string | Non-empty |
| `system_prompt_hash` | string | 64-char hex digest. HMAC-SHA256 keyed off the tenant's `AUDIT_HMAC_KEY`; falls back to plain SHA-256 if unset (back-compat) |
| `input_data_hash` | string | 64-char hex digest. HMAC-SHA256 keyed off the tenant's `AUDIT_HMAC_KEY`; falls back to plain SHA-256 if unset (back-compat) |
| `ai_decision_output` | object | Non-null, non-array JSON object |
| `human_in_loop` | boolean | Strict boolean |

Fields added by the ingest Lambda before enqueuing: `tenant_id`, `_ingested_at` (stripped before storage).

### Stored document (DynamoDB + S3)

All ingest fields plus `tenant_id` and `sequence_no` (assigned by the processor). The `sk` field (`{timestamp}#{event_id}`) is stored in DynamoDB only and stripped from API responses. `sequence_no` is stored in both DynamoDB and the S3 archive copy so a restore from S3 preserves the original per-tenant ordering.

---

## 6. CDK context parameters

Passed at deploy time with `--context key=value`:

| Parameter | Default | Purpose |
|---|---|---|
| `rateLimitPerMinute` | `100` | Per-tenant ingest rate limit |
| `retentionYears` | `7` | S3 Object Lock retention period |
| `alertEmail` | (none) | Subscribed to the DLQ + integrity-check SNS topics |
| `sesSenderEmail` | (none) | Verified SES sender for tenant notifications |
| `corsOrigin` | dashboard CloudFront URL | API CORS allow-list |

**Note:** API keys (`tenantKeyMap`, `readKeyMap`) are no longer accepted as deploy-time context. They are populated **once** in Secrets Manager via the AWS Console after the first deploy, and the CloudFormation template is structured so that subsequent redeploys leave the live secret values untouched. See `GETTING-STARTED.md` step 10.

---

## 7. Key design decisions

**SQS between ingest and processor**
Decouples the customer-facing response (202, fast) from the storage write (slower, retryable). Customers are not blocked waiting for DynamoDB and S3 writes to complete. If the processor fails, the message stays in the queue and retries up to 5 times before going to the DLQ.

**DynamoDB sort key as `timestamp#event_id`**
ISO 8601 timestamps sort lexicographically in the same order as chronologically, so a DynamoDB range query on SK naturally returns records in time order. Appending `#event_id` makes the key unique even if two events share a timestamp.

**S3 Object Lock over custom hash chaining**
Object Lock COMPLIANCE mode is a recognised regulatory standard (SEC 17a-4, FINRA, HIPAA). It requires no custom verification logic — the guarantee comes from AWS's platform. An auditor can understand it without needing to audit the code.

**Two separate storage layers (DynamoDB + S3)**
DynamoDB is optimised for queries; S3 is optimised for immutability. Using both means queries are fast and the tamper-evidence proof is independent of the query layer. If the DynamoDB record is ever altered (e.g. by a misconfigured process), the S3 copy exposes the discrepancy.

**Secrets Manager over environment variables**
API keys in environment variables appear in CloudFormation outputs, Lambda configuration pages, and any tooling that lists Lambda settings. Secrets Manager keeps the values out of all those surfaces and provides a clean rotation path.

**Reserved concurrency on Processor (10)**
Prevents the processor from consuming all available Lambda concurrency in the account during a spike, which would starve other functions. The SQS queue absorbs the spike instead.

**RETAIN removal policy on audit data**
DynamoDB AuditTable, S3 AuditBucket, and Secrets Manager secrets all have `RemovalPolicy.RETAIN`. Running `cdk destroy` will not delete compliance records. Manual deletion via the AWS console requires deliberate action.
