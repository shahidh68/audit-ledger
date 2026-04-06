# AI Audit Ledger — Operations Runbook

This is the day-to-day operations guide. It covers everything you need to manage the live system — adding customers, rotating keys, monitoring, and handling problems.

---

## Adding a new customer

**What you need first:**
- A name or short ID for the customer (e.g. `acme-hr`)
- A new API key generated for them

**Step 1 — Generate a key**
Go to **passwordsgenerator.net** — set length to 32, letters and numbers only, no symbols. Copy the result. This is their tenant key.

**Step 2 — Add them to Secrets Manager**
1. Go to **AWS Console → Secrets Manager**
2. Find the secret with **TenantKeyMap** in its name
3. Click **Retrieve secret value**
4. Click **Edit**
5. The value looks like this:
   ```json
   {"existing-key":"existing-tenant"}
   ```
6. Add the new customer on a new line:
   ```json
   {"existing-key":"existing-tenant","new-customer-key":"acme-hr"}
   ```
7. Click **Save**

The system picks up the new key within seconds. No redeployment needed.

**Step 3 — Send the customer their details**
Give them:
- Their **tenant key** (the one you just generated)
- The **Ingest URL** from your deployment outputs
- A link to the SDK (Python or Node) from the `sdk/` folder

---

## Removing a customer

1. Go to **AWS Console → Secrets Manager**
2. Find the secret with **TenantKeyMap** in its name
3. Click **Retrieve secret value → Edit**
4. Delete their line from the JSON
5. Click **Save**

Their key stops working immediately. Their existing records remain in the system.

---

## Rotating a customer's key (they think their key was leaked)

1. Generate a new key (passwordsgenerator.net, 32 chars)
2. Go to **Secrets Manager → TenantKeyMap → Edit**
3. Replace their old key with the new one (keep their tenant ID the same)
4. Save
5. Send them the new key

Their old key stops working immediately. No records are lost.

---

## Adding or changing a read key (dashboard access)

1. Go to **AWS Console → Secrets Manager**
2. Find the secret with **ReadKeyMap** in its name
3. Click **Retrieve secret value → Edit**
4. The value looks like this:
   ```json
   {"your-read-key":"*"}
   ```
5. To add a tenant-scoped read key (they can only see their own records):
   ```json
   {"your-read-key":"*","acme-hr-read-key":"acme-hr"}
   ```
6. Save

`"*"` = admin, sees all tenants. Any other value = scoped to that tenant only.

---

## Checking the system is healthy

**Quick check — send a test record:**
```
curl -i -X POST "YOUR_INGEST_URL" ^
  -H "Content-Type: application/json" ^
  -H "x-api-key: YOUR_TENANT_KEY" ^
  -d "{\"event_id\":\"a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5\",\"timestamp\":\"2026-04-06T12:00:00Z\",\"model_version\":\"gpt-4o\",\"system_prompt_hash\":\"aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd\",\"input_data_hash\":\"bbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaa\",\"ai_decision_output\":{\"decision\":\"approved\",\"score\":87},\"human_in_loop\":false}"
```

Expected response: `HTTP 202` and the record appears in the dashboard within a few seconds.

**Check the dead-letter queue (DLQ):**
1. Go to **AWS Console → SQS**
2. Find the queue with **DLQ** in its name
3. Check **Messages available** — this should always be **0**
4. If it is above 0, records are failing to save — see the Troubleshooting section below

---

## Monthly checks

| Task | Where | What to look for |
|---|---|---|
| Check DLQ | SQS → IngestDLQ | Should be 0 messages |
| Check Lambda errors | CloudWatch → Log groups | Any ERROR lines |
| Review AWS bill | Billing dashboard | Unexpected cost spikes |
| Confirm records are saving | Dashboard | Send a test record, verify it appears |

---

## Redeploying after a code change

If the code is updated, redeploy with:

```
cd "C:\Users\AI Data Logger\ai-audit-ledger\infra\cdk"
npx cdk deploy --require-approval never --context tenantKeyMap="{\"your-tenant-key\":\"your-tenant\"}" --context readKeyMap="{\"your-read-key\":\"*\"}"
```

**Important:** You do not need to redeploy just to add or rotate keys. Only redeploy when the Lambda code or infrastructure has changed.

---

## Troubleshooting

### A customer says their records are not appearing in the dashboard

1. Ask them to confirm they are getting `202` responses from the ingest URL
2. Check the DLQ (SQS → IngestDLQ) — if messages are there, the processor is failing
3. Check CloudWatch logs for the ProcessorFn Lambda:
   - Go to **CloudWatch → Log groups**
   - Find `/aws/lambda/AiAuditLedgerStack-ProcessorFn...`
   - Look for ERROR lines

### A customer is getting 401 Unauthorized

Their key is wrong or not in Secrets Manager. Check:
1. Go to **Secrets Manager → TenantKeyMap → Retrieve secret value**
2. Confirm their key is listed exactly as they are sending it (case sensitive, no spaces)

### A customer is getting 429 Too Many Requests

They are sending more than 100 requests per minute. Either:
- Their code has a bug sending duplicate requests
- They have a legitimate high-volume need — increase the rate limit

To increase the rate limit for all tenants, redeploy with:
```
npx cdk deploy --require-approval never --context rateLimitPerMinute="500" --context tenantKeyMap="..." --context readKeyMap="..."
```

### The dashboard shows "Integrity check failed" for a record

This means the DynamoDB copy of a record does not match the S3 archived copy. This is serious — it could indicate tampering or a processing error.

1. Note the event ID
2. Go to **S3 → AuditBucket → find the file** `{tenant_id}/{event_id}.json`
3. Compare the contents to what the dashboard shows
4. If records differ, escalate immediately — do not delete anything
5. Contact your legal team

### The dashboard cannot connect

1. Check the API Base URL has no trailing slash and starts with `https://`
2. Confirm the read key is correct (Secrets Manager → ReadKeyMap → Retrieve secret value)
3. Check API Gateway is running: AWS Console → API Gateway → AiAuditLedger → Stages → prod

---

## Key information to keep safe

Store all of the following in a password manager:

| Item | Where to find it |
|---|---|
| Ingest URL | CloudFormation → AiAuditLedgerStack → Outputs |
| Read URL | CloudFormation → AiAuditLedgerStack → Outputs |
| Tenant key map | Secrets Manager → TenantKeyMap secret |
| Read key map | Secrets Manager → ReadKeyMap secret |
| AWS account ID | AWS Console → top right corner |
| AWS region | eu-west-1 (or whichever you deployed to) |

---

## Emergency contacts

| Situation | Action |
|---|---|
| AWS outage | Check **status.aws.amazon.com** |
| Suspected data breach | Contact your legal team immediately, do not delete any records |
| Unexpected AWS bill | Go to **Billing → Cost Explorer** to identify the source |
| Need AWS support | AWS Console → Support → Create case |
