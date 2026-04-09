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
8. [Troubleshooting](#8-troubleshooting)
9. [Key information to keep safe](#9-key-information-to-keep-safe)
10. [Emergency contacts](#10-emergency-contacts)

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
3. Run the deploy command with your keys:
   ```
   npx cdk deploy --require-approval never --context tenantKeyMap="{\"your-tenant-key\":\"your-tenant\"}" --context readKeyMap="{\"your-read-key\":\"*\"}"
   ```
4. Wait 5–10 minutes for the deploy to complete
5. Check the Outputs section at the end — confirm the URLs are the same as before

---

## 8. Troubleshooting

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
  npx cdk deploy --require-approval never --context rateLimitPerMinute="500" --context tenantKeyMap="..." --context readKeyMap="..."
  ```

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

## 9. Key information to keep safe

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

## 10. Emergency contacts

| Situation | Who to contact | What to do |
|---|---|---|
| AWS service outage | — | Check **status.aws.amazon.com**, wait for resolution |
| Suspected data breach or tampering | Your legal team | Do not delete anything, preserve all evidence |
| Unexpected AWS bill spike | — | Go to **Billing → Cost Explorer**, identify the source, contact AWS support if needed |
| Technical issue you cannot resolve | Developer | Share the exact error message from CloudWatch logs |
| Need AWS support | AWS | AWS Console → Support → Create case |
