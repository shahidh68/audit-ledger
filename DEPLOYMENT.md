# AI Audit Ledger — How to put it live (plain-English guide)

**Architecture and setup (diagrams + how the pieces connect):** see [SETUP-AND-ARCHITECTURE.md](./SETUP-AND-ARCHITECTURE.md).  
**Plain-English explanation (what each piece does):** see [LAYMAN-GUIDE.md](./LAYMAN-GUIDE.md).

**What “deploy” means here:** You are asking Amazon Web Services (AWS) to create the servers, databases, and web addresses this product needs, so your customers can send audit logs and your team can read them.

**Where this project lives on your PC:**  
`C:\Users\AI Data Logger\ai-audit-ledger`

**Where the “go live” instructions are in the project:**  
`infra\cdk` (this folder contains the automated setup script for AWS).

---

## What you get after a successful deploy (in everyday terms)

Think of it as three main jobs working together:

1. **A public web address (API)** — Other companies’ systems can **send** AI decision records to you. Your dashboard or tools can **read** those records back.
2. **A short waiting line (queue)** — When someone sends data, it is accepted quickly. The heavy work of saving it permanently happens a moment later, so the sender is not kept waiting.
3. **A searchable index (DynamoDB)** — Records are stored in a fast database so you can list and filter them by date, customer, or event ID.
4. **A permanent sealed vault (S3 Object Lock)** — Every record is also written to a vault where it is physically locked and cannot be altered or deleted for 7 years. This is the tamper-evidence guarantee, the same standard used for financial regulatory records.
5. **A per-tenant counter (TenantSequenceTable, v0.3+).** Every successfully stored record is given a number. This makes it possible to prove later that no records have been deleted: a missing number is a missing record.

**In slightly more technical words (optional):** API Gateway, SQS, Lambda functions, DynamoDB, and S3 Object Lock work together. You do not need to understand each name to follow the steps below.

---

## Words you might see (simple glossary)

| Term | Plain meaning |
|------|----------------|
| **AWS** | Amazon’s cloud: you rent computers and services there instead of buying your own servers. |
| **Deploy** | Turn on and connect all the cloud pieces so the product actually runs. |
| **Region** | A geographic area where AWS runs its data centres (for example “Europe — Ireland”). Pick one and stick to it unless you have a reason to change. |
| **API key** | A secret password your software sends to prove it is allowed to talk to your system. This project uses two kinds: one for **sending** logs (tenant key) and one for **reading** them (read key). |
| **CDK** | A tool that builds a recipe AWS can follow to create everything in the right order. |

---

## What you need before you start

- A computer with **Node.js** installed (version 18 or newer is fine). Node includes **npm**, which installs small helper programs.
- An **AWS account** (like a login to Amazon’s cloud) and permission to create resources there. If you are not the account owner, ask them to grant you access or to run these steps for you.
- **AWS CLI** installed on your computer — a small program that talks to AWS from the command line. You (or IT) will run something like `aws configure` once to log in (password or SSO, depending on your company).
- **AWS CDK** installed once on your computer:

  ```bash
  npm install -g aws-cdk
  ```

- Patience for a **one-time setup** called **bootstrap** (explained below). You only do that once per AWS account and region.

**Region note:** Everything will be created in whichever AWS region your tools are pointed at. If you are unsure, ask your team which region you should use.

---

## Step 1 — Open the right folder and install pieces the CDK needs

1. Open a terminal (Command Prompt or PowerShell on Windows).
2. Go to the CDK folder:

   ```bash
   cd "C:\Users\AI Data Logger\ai-audit-ledger\infra\cdk"
   ```

3. Install dependencies:

   ```bash
   npm install
   ```

**What this does:** Downloads the software libraries the deployment script needs. It does not turn anything on in the cloud yet.

---

## Step 2 (optional) — Check that the recipe builds on your machine

Still in the same folder, run:

```bash
npx cdk synth
```

**What this does:** Asks the CDK to assemble the plan (“template”) without actually creating anything in AWS. If this finishes without errors, your computer is ready for the real deploy.

---

## Step 3 — Set your passwords (API keys) the secure way

Before you go live, you need to choose the secret keys your customers and read users will use. These are stored in AWS Secrets Manager — a locked vault — not in any config file.

There are two types:
- **Tenant keys** — given to **customers who send** audit events. Each customer gets their own key and their own isolated view of the data.
- **Read keys** — given to **people or tools that only read** logs (for example a compliance dashboard). A read key with the value `"*"` grants admin access to all tenants.

**Format:** Each key map is a JSON object: `{ "the-secret-key": "the-tenant-id" }`. You can list multiple customers.

**You do not pass keys to the deploy command.** Keys are populated **once** in the AWS Console after the first deploy (covered in Step 6 below). Earlier versions of this guide suggested seeding keys via `--context tenantKeyMap=...` / `--context readKeyMap=...`; that approach silently wiped live keys whenever an operator forgot the flag on a redeploy, so it has been removed.

**Rotating keys later (no redeployment needed):** Keys live in AWS Secrets Manager. To add, remove, or change a key, edit the secret in the Console — the system picks up the change automatically within seconds. You never need to redeploy just to rotate a key.

**Important:** Do not paste real keys into email, public chat, or source control.

---

## Step 4 — One-time “bootstrap” (per AWS account and region)

The first time you use CDK in a given account and region, run (replace with your account number and region):

```bash
npx cdk bootstrap aws://123456789012/eu-west-1
```

**What this does:** Prepares a small storage area AWS needs so future deployments work reliably. You do this **once** per account + region combination.

---

## Step 5 — Deploy (this is the real “go live”)

```powershell
cd "C:\Users\AI Data Logger\ai-audit-ledger\infra\cdk"
npx cdk deploy
```

**What this does:** AWS creates the API, queue, DynamoDB tables, S3 sealed vault, and key vaults according to the project’s recipe. It can take 5–10 minutes on first run.

The two key vaults (`TenantKeyMapSecret`, `ReadKeyMapSecret`) are created with auto-generated placeholder values — you'll replace those with your real keys in Step 6.

**On subsequent deploys** (for code changes): run `npx cdk deploy` again. Your keys in Secrets Manager are preserved across redeploys; the CloudFormation template intentionally leaves the live secret values alone.

---

## Step 6 — Populate your keys (one-time, after first deploy)

The two key vaults exist but contain auto-generated placeholders. Replace them with your real key map.

**TenantKeyMapSecret** — the keys customers will send with their audit events:

1. AWS Console → **CloudFormation** → your stack → **Outputs** → copy `TenantKeySecretArn`.
2. AWS Console → **Secrets Manager** → paste the ARN in search → click the secret.
3. **Retrieve secret value** → **Edit** → **Plaintext** tab.
4. Replace the contents with your customer keys:
   ```json
   {
     "customer-one-key-<long-random-string>": "customer-one",
     "customer-two-key-<long-random-string>": "customer-two"
   }
   ```
5. Save.

**ReadKeyMapSecret** — the keys for the dashboard / read API:

Repeat the same steps using the `ReadKeySecretArn` output. Format:
```json
{
  "your-read-key-<long-random-string>": "*"
}
```
The value `"*"` grants admin access (read across all tenants). Use a tenant id instead of `"*"` to scope a read key to one tenant.

The Lambdas re-read both secrets on every invocation, so your keys take effect immediately.

---

## Step 7 — Save what the deployment prints (very important)

When deployment finishes, AWS shows a list of **Outputs** (you can also find them in the AWS console under **CloudFormation** → your stack).

**Save these somewhere safe** (for example a password manager or internal runbook):

| Output name | Why it matters |
|-------------|----------------|
| **ApiBaseUrl** | The main web address of your API. |
| **IngestUrl** | The exact address customer systems should **POST** to when sending data. |
| **ReadUrl** | The address for **reading** logs. |
| **TenantKeySecretArn** | The location of the tenant key vault in AWS. Go here to add/remove customers. |
| **ReadKeySecretArn** | The location of the read key vault in AWS. Go here to manage dashboard/admin access. |
| **AuditBucketName** | The name of the S3 sealed vault (useful for support/audits). |
| **AuditTableName** | The name of the DynamoDB index table (for support/debugging). |
| **QueueUrl** | The address of the internal queue (usually only for technical troubleshooting). |

**Note on API keys:** Your keys are stored in AWS Secrets Manager, not shown in these outputs. To find them after deploy, go to AWS Console → Secrets Manager → `ai-audit-ledger/tenant-key-map` or `ai-audit-ledger/read-key-map`.

---

## Step 8 — Quick “is it working?” checks (optional)

**A) Recipe only (no cloud):**

```bash
cd "C:\Users\AI Data Logger\ai-audit-ledger\infra\cdk"
npx cdk synth
```

**B) Send a test record** — Your technical teammate can use a tool like `curl` or the provided SDKs. The **IngestUrl** is the target, and the **tenant** API key must go in the request header (`x-api-key`) and match the same value inside the JSON body. A successful send usually returns **202 Accepted**.

**C) Read logs back** — Use **ReadUrl** with the **read** key (not the tenant key).

Exact commands are in the technical appendix below if you need them.

---

## Using the small helper libraries (SDKs)

- **Python** (`sdk\python`): Lets your developers send logs from Python code. They install it locally, point it at **IngestUrl**, and use the tenant API key.
- **Node.js** (`sdk\nodejs`): Same idea for JavaScript/Node servers.

Both libraries hash sensitive text locally before sending, so raw personal data is not uploaded to your API. From v0.3, the hashing uses HMAC-SHA256 with a secret your team generates and holds (`AUDIT_HMAC_KEY`). We never see that secret, which is what makes the hashed values legally pseudonymised rather than just fingerprinted. If the secret is not set, the libraries fall back to plain SHA-256 with a one-time deprecation warning, so existing setups keep working unchanged.

---

## Day-to-day notes (non-technical summary)

- **First save:** The first time data is processed, the system creates the database table it needs. That is normal.
- **Costs:** Running services in AWS usually costs money. Check AWS pricing and billing alerts for your account.
- **Turning everything off:** If you run `npx cdk destroy AiAuditLedgerStack`, some pieces may be kept on purpose to avoid accidental data loss. Your technical team should clean up any remaining resources in the AWS console if you truly want them gone.

---

## If something goes wrong (simple)

| What you see | What to try first |
|--------------|-------------------|
| Errors during `npm install` or `cdk synth` | Make sure you are in `infra\cdk`, Node.js is installed, and try again. |
| Deploy says something about bootstrap | Complete Step 4 for your account and region. |
| “Not authorised” or 401 when sending data | Check the tenant key matches what you configured, and that the same key appears in the header and the body as required. |
| “Not authorised” when reading | Use the **read** key, not the tenant key. |
| Data is slow to appear | Wait a few seconds; sending is fast, saving runs in the background. |
| Technical errors in the cloud | Someone with AWS access should open **CloudWatch** logs for the Lambda functions named in the project (for example the processor function). |

---

## Technical appendix — curl examples (for developers)

Replace placeholders with your real URLs and keys from the deployment outputs.

**Send (ingest):**

```bash
curl -i -X POST "https://YOUR_API_ID.execute-api.REGION.amazonaws.com/prod/audit/events" ^
  -H "Content-Type: application/json" ^
  -H "x-api-key: YOUR_TENANT_KEY" ^
  -d "{\"event_id\":\"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx\",\"timestamp\":\"2026-04-02T12:00:00Z\",\"tenant_api_key\":\"YOUR_TENANT_KEY\",\"model_version\":\"gpt-4o\",\"system_prompt_hash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"input_data_hash\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"ai_decision_output\":{\"risk_score\":85},\"human_in_loop\":true}"
```

**Read list:**

```bash
curl -s "https://YOUR_API_ID.execute-api.REGION.amazonaws.com/prod/audit/logs" ^
  -H "x-api-key: YOUR_READ_KEY"
```

**Read history for one event (tamper check):**

```bash
curl -s "https://YOUR_API_ID.execute-api.REGION.amazonaws.com/prod/audit/events/YOUR_EVENT_ID/history" ^
  -H "x-api-key: YOUR_READ_KEY"
```

**Verify completeness for the calling tenant (v0.3+):**

```bash
curl -s "https://YOUR_API_ID.execute-api.REGION.amazonaws.com/prod/audit/verify-completeness" ^
  -H "x-api-key: YOUR_READ_KEY"
```

Returns the current counter, the count of records found, and the list of any missing sequence numbers. Add `?from=<n>&to=<n>` to narrow the range.

---

## Where things live in the project (for orientation)

```
ai-audit-ledger/
  DEPLOYMENT.md     ← this guide
  schemas/          ← definitions of the data format
  sdk/              ← Python and Node helpers for customers
  infra/cdk/        ← the automated AWS setup (main deploy folder)
```

If your organisation changes URLs, keys, or security rules, a developer will usually edit `infra\cdk\lib\ai-audit-stack.ts` and run **deploy** again.
