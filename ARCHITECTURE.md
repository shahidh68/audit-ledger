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

- Raw PII (names, CVs, identifiers) should be hashed by the SDK before sending
- The API stores hashes, decision outputs, and metadata — not raw personal data
- This supports GDPR data minimisation obligations

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
   a. PutItem to DynamoDB (sk = timestamp#event_id, idempotent condition)
   b. PutObject to S3 with COMPLIANCE lock and retention date
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

---

## 5. Payload schema

### Ingest request body

| Field | Type | Validation |
|---|---|---|
| `event_id` | string | UUID v4 |
| `timestamp` | string | ISO 8601 |
| `model_version` | string | Non-empty |
| `system_prompt_hash` | string | SHA-256 hex (64 chars) |
| `input_data_hash` | string | SHA-256 hex (64 chars) |
| `ai_decision_output` | object | Non-null, non-array JSON object |
| `human_in_loop` | boolean | Strict boolean |

Fields added by the ingest Lambda before enqueuing: `tenant_id`, `_ingested_at` (stripped before storage).

### Stored document (DynamoDB + S3)

All ingest fields plus `tenant_id`. The `sk` field (`{timestamp}#{event_id}`) is stored in DynamoDB only and stripped from API responses.

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
