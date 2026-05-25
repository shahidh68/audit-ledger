# How to Run the Resume-Screener Simulator

Step-by-step runbook to go from zero to a live, populated dashboard. Follow in order — each step assumes the previous succeeded.

> **Time:** ~15 minutes for a first run. ~2 minutes per subsequent run.
> **Cost:** A few cents in AWS Lambda + DynamoDB invocations.

---

## 0. Before you begin — a security reminder

If you have not already done so, **rotate the admin read key** that was shared in chat earlier (Secrets Manager → `ReadKeyMapSecret`). The simulator does not need that key; it uses a separate **write key** (covered in step 2 below).

---

## 1. Prerequisites

You need:

| Requirement | How to verify | What to do if missing |
|---|---|---|
| **Python 3.11+** | `python --version` | Install from python.org |
| **pip** | `pip --version` | Comes with Python 3.11+ |
| **AWS Console access** | Log in to AWS at the account where the stack is deployed | Ask whoever set up the stack for access |
| **The deployed stack URL** | You already have it: `https://m3csva3l3h.execute-api.eu-west-1.amazonaws.com/prod` | — |

You do **not** need:
- AWS CLI configured locally (we'll use the Console for key retrieval)
- Node.js / CDK
- Docker

---

## 2. Get your write keys

The simulator posts events to the **ingest endpoint**, which authenticates with **tenant write keys**. These are different from the dashboard's **read keys**.

| Secret | Purpose | Used by |
|---|---|---|
| `ReadKeyMapSecret` | Read audit logs | Dashboard |
| **`TenantKeyMapSecret`** | **Submit audit events** | **This simulator** |

### 2a. Open the write-key secret

1. Open AWS Console → CloudFormation → your stack (likely `AiAuditStack`) → **Outputs** tab.
2. Find the output named **`TenantKeySecretArn`** (or similar — look for "Tenant" + "Key" + "Arn"). Copy its value.
3. Open AWS Secrets Manager → search by ARN → click the secret → **Retrieve secret value**.

### 2b. Read or populate the secret

The secret holds a JSON map: `{"<write-key-string>": "<tenant_id>", ...}`.

- **If the secret has entries:** the left column ("Secret key") is the write key string; the right column ("Secret value") is the tenant id. Note them down.
- **If the secret is empty (`{}`):** click **Edit** → **Plaintext** tab → paste a JSON map with one or more keys. For multi-tenant simulation we need **at least three** distinct tenants:

  ```json
  {
    "wk-acme-Tw3wB6FGJZxRfYnUm9pvKsAeE2NCxYqL": "acme-corp",
    "wk-globex-Hq9xZmRKpVcWnYbT4Lf2sJgN8DAEvUP": "globex-inc",
    "wk-initech-Bn3pXqKsWvFrZmHc7Dt4yEgL9JANuMK": "initech"
  }
  ```

  > Generate your own random strings — don't use the example above. Each value (40+ chars) acts as a password. The keys you'll paste into your `.env`; the values become tenant labels in the dashboard.

  Save. The Lambda re-reads on every request, so changes take effect immediately.

### 2c. What you should now have written down

```
WRITE_KEY_1 = wk-acme-...                  →  tenant: acme-corp
WRITE_KEY_2 = wk-globex-...                →  tenant: globex-inc
WRITE_KEY_3 = wk-initech-...               →  tenant: initech
INGEST_URL  = https://m3csva3l3h.execute-api.eu-west-1.amazonaws.com/prod/audit/events
```

You're done with AWS. Close the Console.

---

## 3. Install the app

Open a terminal in the repo root (`C:\Users\AI Data Logger\ai-audit-ledger`).

```bash
# Optional but recommended — isolate dependencies in a virtual env
python -m venv .venv
source .venv/Scripts/activate         # Git Bash / WSL on Windows
# .venv\Scripts\activate              # PowerShell
# .venv\Scripts\activate.bat          # cmd.exe

# 1. Install the SDK in editable mode
pip install -e ./sdk/python

# 2. Install the simulator in editable mode
pip install -e ./apps/resume-screener
```

Verify:

```bash
python -m resume_screener --help
```

You should see two commands listed: `decide` and `generate`.

---

## 4. Configure `.env`

```bash
cp ./apps/resume-screener/.env.example ./apps/resume-screener/.env
```

Open `apps/resume-screener/.env` in your editor and fill in:

```bash
# Note the path ends with /audit/events (not just /prod)
AUDIT_INGEST_URL=https://m3csva3l3h.execute-api.eu-west-1.amazonaws.com/prod/audit/events

# Used by `decide` (single decision)
AUDIT_WRITE_KEY=wk-acme-...                 # paste WRITE_KEY_1

# Used by `generate` (multi-tenant batch)
AUDIT_WRITE_KEYS=wk-acme-...,wk-globex-...,wk-initech-...
```

> The `.env` file is git-ignored — your keys won't be committed.

---

## 5. First run — a single decision

From the repo root:

```bash
cd apps/resume-screener
python -m resume_screener decide --resume samples/resume.txt --jd samples/jd.txt
```

**Expected output:**

```json
{
  "decision": "shortlist",
  "confidence": 1.0,
  "signals": {
    "skills_match": 1.0,
    "experience_match": 1.0,
    "education_match": 1.0
  },
  "top_reasons": [
    "Matches 6 JD skills (python, aws, kubernetes, docker, terraform…)",
    "8+ years experience meets 7-year requirement"
  ],
  "model_version": "screener-v0.3"
}
✓ logged event to ledger (wk-a…3SXc)
```

If you see the `✓ logged event to ledger` line, the SDK successfully posted to the ingest endpoint.

---

## 6. Single decision with a captured human review

```bash
python -m resume_screener decide \
  --resume samples/resume.txt \
  --jd samples/jd.txt \
  --review
```

You'll be prompted:

```
— AI decision —
  decision:   shortlist
  confidence: 1.0
  ...

Review this decision? [y/N]: y
Final decision (shortlist/refer/reject): shortlist
Reason (one line): Strong cultural fit signals from cover letter
Reviewer handle [anonymous]: alex.chen
```

The captured review is added to the event payload at `ai_decision_output.human_review`, and `human_in_loop` is set to `true`.

---

## 7. Verify on the dashboard

Open the dashboard:

```
https://d2pfirb2397ixy.cloudfront.net
```

Connect with your **read** key (the rotated one from Secrets Manager → `ReadKeyMapSecret`).

You should see your test event(s) in the table within a few seconds. Click the row to open the detail panel and confirm the `human_review` sub-object is present in the `AI Decision Output` JSON.

---

## 8. Multi-tenant batch — populate the dashboard

This is the showcase command. It generates 120 synthetic decisions, distributed across 3 tenants, spread evenly over 5 minutes:

```bash
python -m resume_screener generate \
  --count 120 \
  --duration 5m \
  --human-review-rate 0.25
```

What you'll see in the terminal:

```
→ generating 120 events over 300s across 3 tenant key(s) (wk-a…3SXc, wk-g…vUPs, wk-i…NuMK); concurrency=8
ingest:  47%|████████          | 56/120 [02:21<02:38, 2.5s/ev]
```

**Watch the dashboard live during the run** — each ~2.5 seconds, a new event arrives:

| KPI | What you should see |
|---|---|
| **Events** | Counts up from 0 to ~120 |
| **Sparkline** | Builds left-to-right across the 5-minute window |
| **Human review** | Settles around 25–40% (refer decisions auto-review) |
| **Tenants** | Dot grid fills with 3 colored dots |
| **Models** | Shows `screener-v0.3` and `screener-v0.2` |

When complete:

```
✓ done in 301.2s — 120 ok, 0 failed
```

---

## 9. Useful variations

```bash
# Quick demo — 30 events in 30 seconds
python -m resume_screener generate --count 30 --duration 30s

# Single tenant, more concurrency
python -m resume_screener generate --count 200 --duration 5m \
  --api-key wk-acme-... --concurrency 16

# Reproducible run for a screen recording
python -m resume_screener generate --count 60 --duration 2m --seed 42

# Try the weak resume to see a 'reject' decision
python -m resume_screener decide --resume samples/resume-junior.txt \
                                 --jd samples/jd.txt
```

---

## 10. Troubleshooting

### `Missing ingest URL` / `Missing write key`
Your `.env` isn't being loaded. Make sure you're running the command from a directory that contains `.env`, or set the env vars directly:
```bash
AUDIT_INGEST_URL=https://... AUDIT_WRITE_KEY=wk-... python -m resume_screener decide ...
```

### `✗ ledger ingest failed: HTTP 401`
The write key is wrong or not in `TenantKeyMapSecret`. Re-check step 2.

### `✗ ledger ingest failed: HTTP 400`
Likely a payload validation error from the Lambda. Most common cause: the ingest URL is missing the `/audit/events` suffix (e.g., you pasted just `.../prod`).

### `Could not connect`
Network or DNS issue. Run a quick check:
```bash
curl -i https://m3csva3l3h.execute-api.eu-west-1.amazonaws.com/prod/audit/events \
  -H "x-api-key: wk-acme-..." -X POST -d '{}'
# Expect: HTTP/2 400 (validation error proves auth + reachability)
```

### Events appear but tenant column shows only one tenant
You're using `--api-key` (single) instead of `--api-keys` (multi). Use the plural form, or set `AUDIT_WRITE_KEYS` in `.env`.

### Dashboard says `No records in this range`
Widen the date filter — events are timestamped at "now", so make sure the `To` date includes today.

---

## 11. Quick reference

| Command | Purpose |
|---|---|
| `python -m resume_screener decide --resume R --jd J` | One AI decision, no human review |
| `python -m resume_screener decide --resume R --jd J --review` | One AI decision + interactive human review |
| `python -m resume_screener decide --resume R --jd J --dry-run` | Decide but don't log (testing) |
| `python -m resume_screener generate --count N --duration 5m` | Spread N events over a window |
| `python -m resume_screener generate ... --api-keys "k1,k2,k3"` | Multi-tenant round-robin |
| `pytest apps/resume-screener` | Unit tests (no network) |

| Env var | Used by | Source |
|---|---|---|
| `AUDIT_INGEST_URL` | both | API Gateway URL + `/audit/events` |
| `AUDIT_WRITE_KEY` | `decide` | `TenantKeyMapSecret` (one entry) |
| `AUDIT_WRITE_KEYS` | `generate` | `TenantKeyMapSecret` (comma-joined) |

---

## 12. What is **not** required

- ❌ The read key (that's only for the dashboard)
- ❌ AWS CLI on your laptop
- ❌ Anthropic / OpenAI API keys (the "AI" is simulated)
- ❌ A separate database — events are stored by the existing ledger
- ❌ Any change to the existing repo — the simulator is fully self-contained under `apps/resume-screener/`
