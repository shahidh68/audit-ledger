# AI Audit Ledger — Operations Runbook

This is the day-to-day operations guide for managing the live system. Every procedure is written as numbered steps you can follow without technical background.

---

## Contents

1. [Adding a new customer](#1-adding-a-new-customer)
2. [Removing a customer](#2-removing-a-customer)
3. [Rotating a customer's key](#3-rotating-a-customers-key)
4. [Adding dashboard access for someone](#4-adding-dashboard-access-for-someone)
5. [Checking the system is healthy](#5-checking-the-system-is-healthy)
6. [Monthly checks](#6-monthly-checks)
7. [Redeploying after a code change](#7-redeploying-after-a-code-change)
8. [Email alerts — what they mean and what to do](#8-email-alerts--what-they-mean-and-what-to-do)
9. [Troubleshooting](#9-troubleshooting)
10. [Key information to keep safe](#10-key-information-to-keep-safe)
11. [Emergency contacts](#11-emergency-contacts)
12. [The customer's HMAC key — what it is and how to support them](#12-the-customers-hmac-key--what-it-is-and-how-to-support-them)
13. [Investigating a completeness gap](#13-investigating-a-completeness-gap)
14. [Understanding `sequence_burned` log entries](#14-understanding-sequence_burned-log-entries)

---

## 1. Adding a new customer

Do this when a new customer signs up and needs to start sending audit records.

**What you need:**
- A short name for the customer with no spaces (example: `acme-hr`, `globex-finance`)

---

**Step 1 — Generate a unique API key for them**

1. Open your browser and go to **passwordsgenerator.net**
2. Set the length to **32**
3. Make sure **Include Numbers** and **Include Lowercase Letters** are ticked
4. Make sure **Include Symbols** is unticked
5. Click **Generate Password**
6. Copy the result — this is their API key
7. Save it somewhere safe (password manager) — you will need it in Step 3

---

**Step 2 — Open AWS Secrets Manager**

1. Go to **aws.amazon.com** and sign in
2. In the search bar at the top, type **Secrets Manager** and click it
3. You will see a list of secrets — find the one with **TenantKeyMap** in its name and click it
4. Click the **Retrieve secret value** button
5. You will see something like this:
   ```
   {"existing-customer-key":"existing-customer"}
   ```
6. Click **Edit**

---

**Step 3 — Add the new customer**

1. The secret value is a JSON object — it looks like a list of key-value pairs inside curly brackets `{ }`
2. Add a comma after the last entry, then add the new customer on the same line:
   ```
   {"existing-customer-key":"existing-customer","new-api-key":"acme-hr"}
   ```
   Replace `new-api-key` with the key you generated in Step 1, and `acme-hr` with the customer's short name
3. Click **Save**
4. Done — the new key works within seconds, no redeployment needed

---

**Step 4 — Send the customer their details**

Send them the following in a secure message (not plain email if possible):

- Their **API key** (the one you generated in Step 1)
- Your **Ingest URL** — find this in AWS Console → CloudFormation → AiAuditLedgerStack → Outputs → IngestUrl
- The SDK folder from the project (`sdk/python` or `sdk/nodejs`) so their developers can integrate
- A note pointing them at **Section 12** of this runbook, which explains the HMAC key they need to generate on their side. You do not generate that key for them. It is the one secret they must hold themselves so the ledger never sees something that could be linked back to a real person.

---

## 2. Removing a customer

Do this when a customer leaves or their access needs to be revoked immediately.

1. Go to **aws.amazon.com** → sign in
2. Search for **Secrets Manager** and click it
3. Find the secret with **TenantKeyMap** in its name and click it
4. Click **Retrieve secret value**
5. Click **Edit**
6. Find the customer's line in the JSON and delete it, including the comma before or after it
   - Before: `{"acme-hr-key":"acme-hr","globex-key":"globex"}`
   - After removing acme-hr: `{"globex-key":"globex"}`
7. Click **Save**

Their key stops working immediately. Their existing records remain safely stored and are not deleted.

---

## 3. Rotating a customer's key

Do this if a customer believes their key has been leaked or compromised.

> **Note:** This procedure rotates the **API write key** (and equivalently the read key) that the customer uses to authenticate against the ledger API. It does **not** cover their **HMAC key** (`AUDIT_HMAC_KEY`), which the customer generates and holds themselves. If a customer asks you to rotate their HMAC key, send them to Section 12 — that one is their responsibility, not yours, because you never see it.

1. Go to **passwordsgenerator.net** and generate a new 32-character key (same as Step 1 above)
2. Go to **AWS Console → Secrets Manager → TenantKeyMap → Retrieve secret value → Edit**
3. Find the customer's current key in the JSON
4. Replace just the key part (the bit before the colon) with the new key — keep their tenant name the same
   - Before: `{"old-leaked-key":"acme-hr"}`
   - After: `{"new-safe-key":"acme-hr"}`
5. Click **Save**
6. Send the customer their new key via a secure channel
7. Tell them their old key has been deactivated and they must update their integration immediately

The old key stops working the moment you save. No records are lost.

---

## 4. Adding dashboard access for someone

Do this when a team member or customer needs to view records in the dashboard.

**There are two types of access:**
- **Admin access** — can see all customers' records (for your internal team only)
- **Tenant access** — can only see one specific customer's records (give this to customers)

---

**Step 1 — Generate a read key**

1. Go to **passwordsgenerator.net**
2. Generate a 32-character key (letters and numbers, no symbols)
3. Save it somewhere safe

---

**Step 2 — Add the key to Secrets Manager**

1. Go to **AWS Console → Secrets Manager**
2. Find the secret with **ReadKeyMap** in its name and click it
3. Click **Retrieve secret value → Edit**
4. The value looks like this:
   ```
   {"existing-read-key":"*"}
   ```
5. Add the new key:
   - For **admin access**: use `"*"` as the value
     ```
     {"existing-read-key":"*","new-admin-key":"*"}
     ```
   - For **tenant access**: use the customer's short name as the value
     ```
     {"existing-read-key":"*","acme-hr-read-key":"acme-hr"}
     ```
6. Click **Save**

---

**Step 3 — Send them the dashboard**

1. Send them the file `dashboard/index.html` from the project folder
2. They open it in any browser by double-clicking
3. They enter:
   - **API Base URL** — from CloudFormation → AiAuditLedgerStack → Outputs → ApiBaseUrl
   - **Read API Key** — the key you just generated
4. They click **Connect**

---

## 5. Checking the system is healthy

Do this any time you want to confirm the system is working end to end.

---

**Step 1 — Send a test record**

1. Open Command Prompt on your computer
2. Run the following command — replace `YOUR_INGEST_URL` and `YOUR_TENANT_KEY` with your real values:

```
curl -i -X POST "YOUR_INGEST_URL" ^
  -H "Content-Type: application/json" ^
  -H "x-api-key: YOUR_TENANT_KEY" ^
  -d "{\"event_id\":\"a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5\",\"timestamp\":\"2026-04-06T12:00:00Z\",\"model_version\":\"gpt-4o\",\"system_prompt_hash\":\"aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd\",\"input_data_hash\":\"bbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaa\",\"ai_decision_output\":{\"decision\":\"approved\",\"score\":87},\"human_in_loop\":false}"
```

3. You should see `HTTP/2 202` in the response — this means the record was accepted

---

**Step 2 — Check it appears in the dashboard**

1. Open the dashboard (`dashboard/index.html`)
2. Click **Refresh**
3. The test record should appear in the table within a few seconds
4. Click the record to open the detail panel
5. Check the **Tamper-evidence check** section shows a green tick — **Integrity verified**

---

**Step 3 — Check the dead-letter queue**

The dead-letter queue (DLQ) catches records that failed to save. It should always be empty.

1. Go to **AWS Console → SQS** (search for SQS in the top bar)
2. Find the queue with **DLQ** in its name and click it
3. Look at **Messages available** — this must be **0**
4. If it shows any number above 0, records are failing — go to the Troubleshooting section

---

**Step 4 — Check the CloudWatch alarm**

A CloudWatch alarm watches the DLQ automatically and will send you an email if any record ever fails to save. You can check its current state at any time:

1. Go to **AWS Console → CloudWatch** (search for CloudWatch in the top bar)
2. In the left menu click **Alarms → All alarms**
3. Find the alarm named **AiAuditLedger-DLQ-MessageVisible**
4. The **State** column should show **OK** — meaning no failed records
5. If it shows **In alarm** — records are failing. Go to the Troubleshooting section immediately.

**If you provided an alertEmail during deployment:** You will receive an automatic email any time the alarm fires. You do not need to check manually — the alarm comes to you.

---

## 6. Monthly checks

Run through this list once a month to keep the system healthy.

| # | Task | Where | What you are looking for |
|---|---|---|---|
| 1 | Check DLQ alarm state | AWS Console → CloudWatch → All alarms → AiAuditLedger-DLQ-MessageVisible | State = OK |
| 2 | Check DLQ is empty | AWS Console → SQS → IngestDLQ | Messages available = 0 |
| 3 | Send a test record | Command Prompt (see Section 5) | HTTP 202 response |
| 4 | Check test record appears | Dashboard | Record visible, integrity verified |
| 5 | Check for Lambda errors | AWS Console → CloudWatch → Log groups | No ERROR lines in the last 30 days |
| 6 | Review AWS bill | AWS Console → Billing → Cost Explorer | No unexpected spikes |
| 7 | Check all customer keys still valid | Secrets Manager → TenantKeyMap | No unexpected entries |

**How to check Lambda logs (Step 4):**
1. Go to **AWS Console → CloudWatch**
2. Click **Log groups** on the left
3. Find `/aws/lambda/AiAuditLedgerStack-ProcessorFn...`
4. Click it and look at the most recent log stream
5. Scan for any lines containing the word ERROR

---

## 7. Redeploying after a code change

Only do this when the Lambda code or infrastructure has been updated. You do **not** need to redeploy just to add or change API keys.

1. Open Command Prompt
2. Navigate to the project folder:
   ```
   cd "C:\Users\AI Data Logger\ai-audit-ledger\infra\cdk"
   ```
3. Run the deploy command:
   ```
   npx cdk deploy --require-approval never
   ```
   Do **not** pass `--context tenantKeyMap=...` or `--context readKeyMap=...` flags — those were removed because forgetting them on a redeploy used to wipe live keys. Keys are now managed exclusively in Secrets Manager.
4. Wait 5–10 minutes for the deploy to complete
5. Check the Outputs section at the end — confirm the URLs are the same as before
6. Confirm your keys are still intact (Secrets Manager → `TenantKeyMapSecret` / `ReadKeyMapSecret`) — they should be unchanged across the redeploy

---

## 8. Email alerts — what they mean and what to do

The system sends automatic email alerts to the address provided during deployment (`alertEmail`). There are two distinct alerts.

---

### Alert 1 — DLQ alarm: "AiAuditLedger-DLQ-MessageVisible"

**What it means:**
An audit record was submitted and accepted by the API but **failed to save to DynamoDB or S3 after 5 retries**. That record is now sitting in the dead-letter queue (DLQ) and will not be retried automatically. This is effectively a **data loss alert** — there is a gap in the audit trail.

**Impact:**
- The affected record is missing from the ledger
- If the customer is using this for EU AI Act or other compliance, a missing record is a reportable gap
- The record will not self-heal without manual action

**What to do when this alert fires:**

1. Go to **AWS Console → SQS**
2. Find the queue with **IngestDLQ** in its name and click it
3. Click **Send and receive messages → Poll for messages** to inspect the failed message
4. Note the `tenant_id` and `event_id` from the message body
5. Go to **AWS Console → CloudWatch → Log groups**
6. Open `/aws/lambda/AiAuditLedgerStack-ProcessorFn...` and find the relevant error
7. Fix the underlying cause (e.g. DynamoDB throttle, S3 permissions error)
8. Once fixed, manually replay the message: select it in the DLQ console and use **Send message** to move it back to the main ingest queue
9. Confirm the record appears in the dashboard after replay

**How to test this alert (PowerShell):**

```powershell
# Step 1 — Reset alarm to OK
aws cloudwatch set-alarm-state --alarm-name "AiAuditLedger-DLQ-MessageVisible" --state-value OK --state-reason "manual reset for testing"

# Step 2 — Trigger alarm (wait ~30 seconds after Step 1)
aws cloudwatch set-alarm-state --alarm-name "AiAuditLedger-DLQ-MessageVisible" --state-value ALARM --state-reason "manual test trigger"

# Step 3 — Reset back to OK after confirming email received
aws cloudwatch set-alarm-state --alarm-name "AiAuditLedger-DLQ-MessageVisible" --state-value OK --state-reason "test complete"
```

Email arrives within 1–2 minutes of the state transition to ALARM.

**Note:** The alarm only fires on a state transition (OK → ALARM). If it is already in ALARM state, you must reset it to OK first before it will send another email.

---

### Alert 2 — Reconciler mismatch: "[AI Audit Ledger] N tamper mismatch(es) detected"

**What it means:**
The hourly reconciler has compared records in DynamoDB against the sealed copies in S3 and found that one or more records **do not match**. This means a record in the searchable database has been modified after it was written. This is the **tamper detection alert**.

**Impact:**
- The audit trail integrity has been compromised for the listed records
- This is a serious compliance event — the affected records cannot be trusted
- Each mismatch is listed in the email with `event_id` and `tenant_id`

**What to do when this alert fires:**

1. **Do not delete or modify anything**
2. Note every `event_id` listed in the alert email
3. For each affected record:
   - Go to **AWS Console → S3 → AuditBucket**
   - Navigate to `{tenant_id}/{event_id}.json` and download it — this is the original sealed copy
   - Go to **AWS Console → DynamoDB → AuditTable**
   - Find the record with the matching `event_id` and compare it to the S3 file
4. If the contents differ, escalate to your legal team immediately with both copies as evidence
5. To see the full diff in the dashboard: `GET /audit/events/{eventId}/history`

**How to test this alert (PowerShell):**

```powershell
# Step 1 — Get the reconciler function name
aws lambda list-functions --query "Functions[?contains(FunctionName,'Reconciler')].FunctionName" --output text

# Step 2 — Reset the watermark to scan historical records
aws dynamodb put-item `
  --table-name <RECONCILER_STATE_TABLE_NAME> `
  --item '{\"pk\":{\"S\":\"lastRunAt\"},\"value\":{\"S\":\"2026-04-05T00:00:00Z\"}}'

# Step 3 — Invoke the reconciler
aws lambda invoke --function-name <RECONCILER_FN_NAME> --payload '{}' $env:TEMP\reconciler-response.json; Get-Content $env:TEMP\reconciler-response.json

# Step 4 — Reset the watermark back to now after testing
aws dynamodb put-item `
  --table-name <RECONCILER_STATE_TABLE_NAME> `
  --item '{\"pk\":{\"S\":\"lastRunAt\"},\"value\":{\"S\":\"2026-04-14T16:00:41Z\"}}'
```

The reconciler runs automatically every hour via EventBridge. In production, mismatches will be detected and reported without manual invocation.

---

### Confirming your SNS subscriptions are active

If you stop receiving alerts, check that your email subscriptions are confirmed (not `PendingConfirmation`):

```powershell
# Check DLQ alert subscription
aws sns list-subscriptions-by-topic --topic-arn "<DLQ_ALERT_TOPIC_ARN>"

# Check mismatch alert subscription
aws sns list-subscriptions-by-topic --topic-arn "<MISMATCH_TOPIC_ARN>"
```

Both should show `SubscriptionArn` as a full ARN, not `PendingConfirmation`. If pending, resubscribe:

```powershell
aws sns subscribe --topic-arn "<TOPIC_ARN>" --protocol email --notification-endpoint <YOUR_EMAIL>
```

Then click the confirmation link in the email AWS sends.

---

## 9. Troubleshooting

### A customer's records are not appearing in the dashboard

1. Ask the customer to confirm they are receiving `202` responses — if they are getting errors, the problem is at their end
2. If they are getting `202` but records are not appearing, check the DLQ:
   - Go to **AWS Console → SQS → IngestDLQ**
   - If messages are present, the processor Lambda is failing
3. Check the processor Lambda logs:
   - Go to **AWS Console → CloudWatch → Log groups**
   - Find `/aws/lambda/AiAuditLedgerStack-ProcessorFn...`
   - Look for ERROR lines and note the error message
   - Share with a developer to investigate

---

### A customer is getting 401 Unauthorized

Their API key is not being accepted. Work through these checks in order:

1. Go to **Secrets Manager → TenantKeyMap → Retrieve secret value**
2. Confirm their key appears exactly as they are sending it — it is case sensitive
3. Check there are no spaces before or after the key in the secret
4. If the key is not there at all, add it following the steps in Section 1
5. Ask the customer to wait 30 seconds and try again — the cache refreshes automatically

---

### A customer is getting 429 Too Many Requests

They are sending more than 100 records per minute. Two possible causes:

- **Their code has a bug** — they may be sending the same event multiple times. Ask them to check.
- **They have a genuine high-volume need** — increase the rate limit by redeploying:
  ```
  npx cdk deploy --require-approval never --context rateLimitPerMinute="500"
  ```
  (Keys are managed in Secrets Manager and survive redeploys; no `tenantKeyMap` / `readKeyMap` context flags needed.)

---

### Duplicate records for the same event_id

If a customer sends the same `event_id` twice but at slightly different timestamps, two DynamoDB records will be created. The reconciler may flag one as a mismatch and the dashboard integrity check may show the wrong record.

**How to detect:**
```powershell
aws dynamodb query --table-name <AUDIT_TABLE> --index-name event_id-index --key-condition-expression "event_id = :eid" --expression-attribute-values '{\":eid\":{\"S\":\"<EVENT_ID>\"}}'  --query "Items[*].{sk:sk.S,timestamp:timestamp.S}"
```
If `Count` is greater than 1, duplicates exist.

**How to fix:**
Delete the older duplicate (the one with the earlier timestamp) using its `sk` value:
```powershell
aws dynamodb delete-item --table-name <AUDIT_TABLE> --key '{\"tenant_id\":{\"S\":\"<TENANT_ID>\"},\"sk\":{\"S\":\"<SK_VALUE>\"}}'
```

**Prevention:**
Customers must generate a new unique `event_id` (UUID v4) for every event. Reusing an `event_id` is a customer integration error.

---

### The dashboard shows "Integrity check failed" on a record

This is serious. It means the copy of the record in the searchable database does not match the original copy in the sealed archive.

1. **Do not delete or modify anything**
2. Note down the full event ID shown in the dashboard
3. Go to **AWS Console → S3**
4. Find the bucket with **AuditBucket** in its name
5. Navigate to `{tenant-id}/{event-id}.json` and download the file
6. Compare its contents to what the dashboard shows in the **AI Decision Output** field
7. If the contents differ, escalate to your legal team immediately with both copies as evidence
8. If the contents are the same, it may be a display formatting issue — contact a developer

---

### The dashboard cannot connect

Work through these in order:

1. Check the API Base URL:
   - Must start with `https://`
   - Must not have a trailing slash at the end
   - Find the correct URL in **CloudFormation → AiAuditLedgerStack → Outputs → ApiBaseUrl**
2. Check the read key:
   - Go to **Secrets Manager → ReadKeyMap → Retrieve secret value**
   - Copy the key exactly as it appears
3. Check API Gateway is running:
   - Go to **AWS Console → API Gateway**
   - Click **AiAuditLedger**
   - Click **Stages** on the left → click **prod**
   - The stage should show a deployment date

---

### The system is not responding at all

1. Check **status.aws.amazon.com** — there may be an AWS outage in your region
2. If AWS is healthy, go to **CloudWatch → Log groups** and check all three Lambda log groups for errors
3. Check **API Gateway → AiAuditLedger** is still deployed

---

## 10. Key information to keep safe

Store all of the following in a password manager. Never share these in plain email.

| Item | Where to find it |
|---|---|
| **Ingest URL** | CloudFormation → AiAuditLedgerStack → Outputs → IngestUrl |
| **Read URL** | CloudFormation → AiAuditLedgerStack → Outputs → ReadUrl |
| **API Base URL** | CloudFormation → AiAuditLedgerStack → Outputs → ApiBaseUrl |
| **All tenant keys** | Secrets Manager → TenantKeyMap secret |
| **All read keys** | Secrets Manager → ReadKeyMap secret |
| **AWS account ID** | AWS Console → click your name top right |
| **AWS region** | eu-west-1 (or whichever you deployed to) |

---

## 11. Emergency contacts

| Situation | Who to contact | What to do |
|---|---|---|
| AWS service outage | — | Check **status.aws.amazon.com**, wait for resolution |
| Suspected data breach or tampering | Your legal team | Do not delete anything, preserve all evidence |
| Unexpected AWS bill spike | — | Go to **Billing → Cost Explorer**, identify the source, contact AWS support if needed |
| Technical issue you cannot resolve | Developer | Share the exact error message from CloudWatch logs |
| Need AWS support | AWS | AWS Console → Support → Create case |

---

## 12. The customer's HMAC key — what it is and how to support them

Do this when onboarding a customer or fielding a question about PII hashing. The HMAC key is the one credential in the whole system that **you do not hold, see, store, or back up**. That is intentional.

**Why a customer-held key matters**

When a customer's application logs an AI decision, it sends a digest of the input data instead of the raw text. The v0.2 version of the system used plain SHA-256 for that digest. A plain SHA-256 hash of a low-entropy value like a name, email, or National Insurance number can be reversed in seconds by anyone with a wordlist, because the search space is small. The ICO and EDPB both treat the resulting digest as still personal data when the operator can reverse it.

The v0.3 design uses HMAC-SHA256 with a secret key the customer generates and keeps. The digest is mathematically not reversible by anyone who does not hold the key. Because the customer holds the key and you do not, the digest is not personal data on your side of the wire. That is what makes the GDPR pseudonymisation claim defensible to a regulator.

---

**What the customer is supposed to do**

When you send them their API key and the SDK folder (Section 1, Step 4), point them at this procedure. Their developer or operator runs this once and stores the result alongside their existing API key.

**Step 1 — Generate a 32-byte secret on their own machine**

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Python equivalent:

```
python -c "import secrets; print(secrets.token_hex(32))"
```

Either prints a 64-character hex string.

**Step 2 — Store it next to AUDIT_WRITE_KEY**

In their `.env` file, secrets manager, vault, or whatever they already use for `AUDIT_WRITE_KEY`. The variable name the SDK and MCP server look for is `AUDIT_HMAC_KEY`.

**Step 3 — Confirm it is being used**

When the SDK or MCP server starts and the variable is set, no warning is printed. When it is **not** set, a one-time deprecation warning is printed on stderr the first time a hash is computed. The presence or absence of that warning is how the customer (and you, if you are helping them) confirm which path is active.

---

**Common questions**

| Question | Answer |
|---|---|
| Can you generate the key for them? | No. Generating it means you held it at some point, which defeats the regulatory claim. They generate. |
| What if they lose the key? | New hashes computed with a new key are fingerprints of the same person but a different value. Existing records remain valid for integrity verification — the ledger compares digests, it does not reverse them. PII lookup across the rotation boundary requires keeping the old key around. |
| Can you tell them what their key is? | No. You never saw it. If they lost it and have no backup, they generate a new one and accept the rotation tradeoff above. |
| What if they refuse to set one? | The SDK and MCP fall back to plain SHA-256 with a one-time deprecation warning. Their integration keeps working. Their digests are weaker than they should be. Their problem, not yours. Note it on the engagement. |
| Should you rotate the key on their behalf? | No. Rotation is theirs. If you ever rotate it for them you were holding it, which defeats the point. |
| Where in the SDK does the key get used? | `sdk/python/ai_audit_ledger/hashing.py` and `sdk/nodejs/src/hashing.mjs` read `AUDIT_HMAC_KEY` from the environment at hash time. It never appears in any outgoing HTTP request. |

---

## 13. Investigating a completeness gap

Do this when a customer's `verify_completeness` call returns a non-empty `missing` array.

`verify_completeness` compares the per-tenant sequence counter against the rows actually present in the audit table. A number in the `missing` array means one of three things:

1. A record was **never written** because of a true race during SQS redelivery. Sequence allocated, audit row never landed. The processor logs this case with `event: "sequence_burned"`. See Section 14.
2. A record **was written but later deleted** from DynamoDB by a misconfigured process or operator action. S3 Object Lock means the original copy still exists.
3. A record **was written but failed to apply its sequence_no** in a partially-failed processor invocation (rare, would also show in CloudWatch with a stack trace).

---

**Step 1 — Triage with the CloudWatch metric filter**

1. Go to **AWS Console → CloudWatch → Logs → Log groups**
2. Open the ProcessorFn log group (`AiAuditLedgerStack-ProcessorFnLogGroup...`)
3. Click **Search log group**
4. Search for `sequence_burned` and filter to the time window when the missing numbers were allocated
5. Cross-reference the `burned_seq` value in each hit against the `missing` array

If every missing number shows up as a `sequence_burned` log entry, the gap is benign infrastructure noise and the customer's records are intact. Reply explaining this and point at the burned-sequence log entries as evidence.

---

**Step 2 — If some missing numbers are not burned, check S3**

If a missing number is not in the burned list, the record may still exist in the S3 archive (which Object Lock makes undeletable). Look for it:

1. Go to **AWS Console → S3** and open the audit bucket (CloudFormation → AuditBucketName output)
2. Browse to the customer's tenant prefix
3. The objects there are keyed by `event_id`, not `sequence_no` — without the `event_id` you cannot directly find the missing record

If the customer can tell you what `event_id` they expected at that sequence, fetch the S3 object and confirm it exists. If it does, the record was deleted from DynamoDB and needs investigation as a possible insider or misconfiguration event. Treat as a serious incident.

---

**Step 3 — Restore from S3 if the customer needs the DynamoDB row back**

The `RestoreApprovalTable` and `RestoreFn` were built for exactly this. The reconciler will auto-detect mismatches at next run (typically nightly). If the customer needs faster recovery, manually invoke the restore handler with the `event_id` and tenant. The restored row is re-stamped with the original `sequence_no` from the S3 archive so the gap closes.

---

## 14. Understanding `sequence_burned` log entries

Do this any time you see a `sequence_burned` log line in the ProcessorFn log group, or when investigating a completeness gap (Section 13).

A `sequence_burned` log line looks like this:

```
{"event":"sequence_burned","tenant_id":"acme-hr","event_id":"40925451-...","burned_seq":47,"reason":"concurrent_write_race"}
```

**What it means**

The processor allocated sequence number 47, then tried to write the audit row, then DynamoDB rejected the write because another processor invocation had already written the same row. The number 47 is now permanently unused. Sequence 48 will go to the next successful write.

**Why this happens**

SQS occasionally redelivers a message before the previous invocation's visibility timeout expires. The pre-flight check on `event_id-index` catches most of these cases by skipping the write entirely. A `sequence_burned` happens when the pre-flight check missed (eventually-consistent GSI returned stale data) but the conditional PutItem caught it.

**Should you do anything about it?**

If you see one or two per week per tenant, no action needed. This is normal SQS behaviour and the gap is harmless — the customer's records are intact. Mention it if they ask, otherwise ignore.

If you see ten or more per day per tenant, that is unusual. Possible causes:

- Increased downstream latency causing visibility timeouts to expire mid-write. Check ProcessorFn duration metrics.
- Manual SQS message replays. Check who has access and what they were doing.
- DynamoDB throttling on the audit table. Check the AuditTable read/write capacity dashboards.

**How to filter for them at scale**

In CloudWatch Logs Insights against the ProcessorFn log group:

```
fields @timestamp, tenant_id, event_id, burned_seq
| filter event = "sequence_burned"
| stats count() by tenant_id
| sort count() desc
```

That gives you a per-tenant burn rate for the time range. Healthy is single-digit per day or less.
