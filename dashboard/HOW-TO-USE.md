# AI Audit Ledger Dashboard — How to Use It

This is a plain-English guide for compliance officers, managers, or anyone who needs to look at AI decision records. No technical knowledge required.

---

## What this dashboard is for

When your company's AI makes a decision — such as scoring a job applicant, approving a loan, or routing a customer — a record of that decision is stored in a secure, tamper-resistant logbook.

This dashboard lets you:
- **Browse** those records by date
- **Inspect** any individual decision in detail
- **Verify** that a record has never been altered (revision history)
- **Export** records to a spreadsheet for regulators or auditors

---

## Opening the dashboard

The dashboard is a single file called `index.html` inside the `dashboard` folder.

**To open it:**
1. Find the file on your computer
2. Double-click it — it opens in your web browser like a normal webpage
3. No installation, no login to a website, no internet required just to open it

> You do need an internet connection when you connect to the live data.

---

## Step 1 — Connecting for the first time

When you first open the dashboard you will see a connection screen asking for two things:

**API Base URL**
This is the web address of your company's audit system. It looks something like:
`https://xxxxxxxx.execute-api.eu-west-1.amazonaws.com/prod`

Your technical team will give you this address after setup. Copy and paste it exactly.

**Read API Key**
This is a password that gives you read-only access to the records. You cannot accidentally change or delete anything with this key — it is view-only by design.

Your technical team will give you this key. Treat it like a password — do not share it publicly.

> **Your details are saved in your browser.** Once you connect, you will not need to enter them again on the same computer. To remove them, click **Disconnect** in the top right corner.

---

## Step 2 — Browsing records

Once connected, you will see a table of AI decision records.

**Each row shows:**

| Column | What it means |
|--------|----------------|
| Timestamp | When the AI decision was made |
| Event ID | A unique reference number for that specific decision |
| Model | Which AI model was used |
| Tenant | Which customer or system sent the record |
| Human review | Whether a person reviewed the AI's decision before it was acted on |

**Filtering by date:**
Use the **From** and **To** date pickers at the top to narrow the list. By default it shows the last 30 days. Click the calendar icons to change the dates — the table updates automatically.

**Refreshing:**
Click the **↻ Refresh** button to reload the latest records from the system.

---

## Step 3 — Inspecting a record

Click any row to open a detailed view on the right-hand side.

This shows you:

**Event details**
The full event ID, exact timestamp, which customer it belongs to, which AI model was used, and whether a human reviewed the decision.

**Privacy hashes**
Instead of storing people's personal data (names, CVs, application forms), the system stores a *fingerprint* of that data. From v0.3 onward, that fingerprint is computed using a secret the customer holds (HMAC-SHA256 with their `AUDIT_HMAC_KEY`), which means even the system operator cannot reverse it back to the original data. This is what regulators expect when you describe a value as pseudonymised, and it is how the system stays GDPR-friendly while still being audit-ready.

**AI Decision Output**
The structured result the AI produced — for example a risk score, a recommendation, or a classification. This is the actual output that was acted upon.

**Tamper-evidence check**
This is the most important section for compliance purposes. The system fetches two copies of the record:

1. The **working copy** from the searchable database (DynamoDB)
2. The **original archived copy** from a sealed vault (S3 Object Lock) — this copy was locked at the moment it was first written and cannot be modified or deleted for 7 years, not even by the account owner

It then compares the two copies and reports one of the following:

- **Green tick — "Integrity verified"**: Both copies are identical. The record is exactly as originally filed. Nothing has been altered.
- **Red cross — "Integrity check failed"**: The two copies do not match. This means the working copy may have been tampered with. This should be investigated immediately and escalated.
- **Grey dash — "Integrity unknown"**: The archived copy could not be retrieved (for example, the record may still be processing). Check again in a few minutes.

The locked S3 archive is the same technology used for financial regulatory records (SEC, FINRA, HIPAA compliance). This is what you would show a regulator as proof that your records are trustworthy.

**Completeness check (v0.3+, currently API-only)**

Tamper-evidence proves a record that exists has not been altered. It does not prove that no record has been deleted. From v0.3, the system provides a separate completeness check that compares the per-tenant sequence counter against the records actually present and returns any missing sequence numbers. The check is available via the `/audit/verify-completeness` endpoint (or the `verify_completeness` MCP tool); a dedicated dashboard button for it is on the roadmap. For now, you can run it directly via the API:

```
curl -H "x-api-key: <your-read-key>" https://<api>/audit/verify-completeness
```

The response shows the counter, the count of records found, and the list of any missing sequence numbers. An empty `missing` array is the answer "yes, no records have been deleted." A non-empty array warrants investigation (see RUNBOOK section 13 for the triage procedure).

---

## Step 4 — Exporting for a regulator or auditor

Click **Export CSV** in the top toolbar.

This downloads a spreadsheet file (`.csv`) containing all the records currently shown in the table, with today's date in the filename. You can open it in Excel, Google Sheets, or any spreadsheet application.

The export includes: event ID, timestamp, tenant, model version, human review status, and the privacy hashes.

> **Tip:** Set your date filters before exporting if you need records for a specific period — for example "all decisions made in Q1 2026."

---

## Step 5 — Disconnecting

Click **Disconnect** in the top right corner. This removes your API key from the browser. The next person to open the dashboard on this computer will need to enter the credentials again.

Do this if you are using a shared computer.

---

## Common questions

**"I see no records."**
Check your date filters — they may be set to a period before any data was sent. Try widening the range. If you are certain data should be there, ask your technical team to confirm the system is receiving events.

**"I get an error when connecting."**
Double-check the API URL — it must start with `https://` and have no trailing slash. Also check the key is correct. If both look right, ask your technical team to confirm the system is deployed and running.

**"The Human Review column shows 'No' for everything."**
This means the AI decisions in that period were not reviewed by a person before being acted on. This may be worth flagging to your compliance team depending on your obligations under the EU AI Act.

**"Can I accidentally delete or change something?"**
No. The read key used by this dashboard is view-only. It is not possible to modify any records through this interface.

**"Where is the actual personal data?"**
It is not here. By design, the system only stores hashes (fingerprints) of personal inputs, not the inputs themselves. The raw data stays in your customers' own systems. This is intentional for GDPR compliance.

---

## Who to contact

If you need to add a new user, rotate your access key, or have questions about a specific record, contact your technical team or the person who set up the system.
