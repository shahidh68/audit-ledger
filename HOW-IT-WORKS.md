# How AI Audit Ledger Works

---

## The problem in one sentence

When a regulator asks "show me every AI decision your system made about this person, and prove none of those records were changed" — most companies can't answer that confidently.

---

## What we do

We give you a single API endpoint. Every time your AI makes a decision, you send us a record. We store it in a way that makes it impossible to alter afterwards.

---

## The three steps for your engineers

```
1. Your AI makes a decision
         ↓
2. You send us a record (takes about 50ms, runs in the background)
         ↓
3. We store it permanently — sealed, tamper-evident, queryable
```

---

## What goes in the record

- Which AI model made the decision and which version
- A fingerprint of the input — not the raw CV or personal data, just a mathematical proof it existed
- The decision output — the score, recommendation, or classification
- Whether a human reviewed it
- A timestamp that cannot be backdated

Personal data never leaves your system. You send fingerprints, not files.

---

## What you get back

- A dashboard your compliance team can open in a browser — no technical knowledge needed
- Filters by date, customer, model version
- One-click tamper-evidence check on any record — proof it has not been touched since it was created
- CSV export for regulators

---

## What the tamper-evidence actually means

Every record is written to two places simultaneously:

1. A searchable database for fast querying
2. A sealed vault that is physically locked — nothing and nobody can modify or delete it for 7 years, including us

When you click the tamper-evidence check on any record, the system compares the two copies. If they match — green tick. If they don't — immediate alert.

That comparison is what you show a regulator.

---

## How long does integration take

For a developer who knows their codebase, less than a day. We provide SDKs for Python and Node.js. The core integration is three lines of code after the AI call.

---

## What it costs to run

The infrastructure runs on AWS at roughly £5–10 per month at normal volumes. Pricing for the service itself is per tenant per month — we can discuss based on your volume.

---

## Who it is for

Any company using AI to make or influence decisions about people — hiring, credit scoring, customer routing, fraud detection — where you may need to demonstrate to a regulator or an auditor that your AI behaved correctly and that the records are genuine.

---

## The integration in plain code

**Python**

```python
from ai_audit_ledger import AuditClient

client = AuditClient(
    ingest_url="https://your-api-url/audit/events",
    api_key="your-tenant-key"
)

# After your AI makes a decision
client.log_event(
    model_version="gpt-4o",
    input_data="the raw text you fed the model",   # hashed locally, never sent
    decision={"recommendation": "shortlist", "score": 94},
    human_in_loop=False
)
```

**What each line does:**

`from ai_audit_ledger import AuditClient`
Load the AI Audit Ledger toolkit into your program. Like plugging in a device before you can use it.

`client = AuditClient(ingest_url=..., api_key=...)`
Set up the connection once. You tell it two things:
- **Where to send records** — the web address of your audit system
- **Your password** — the API key that proves you are allowed to send records

This sits at the top of your code and runs once when your application starts.

`client.log_event(...)`
The one line your developers add after every AI decision. Four things get recorded:

- **model_version** — which AI model made this decision. `gpt-4o` in this example. In practice this would be whatever model your system uses.
- **input_data** — the text or data you fed into the AI. In a hiring context this might be a CV. The SDK takes this, turns it into a fingerprint on your computer, and only sends the fingerprint — the actual CV never leaves your system.
- **decision** — what the AI decided. Here it recommended shortlisting the candidate with a confidence score of 94. This is whatever structured output your AI produces.
- **human_in_loop** — did a person review this decision before it was acted on? `False` here means the AI's output was used directly.

**The whole thing in one sentence:**
Your developer writes one line after every AI decision. That line silently logs the record to the audit system in the background in about 50 milliseconds — fast enough that nobody notices, and your compliance evidence is automatically taken care of.

**Node.js**

```javascript
import { AuditClient } from 'ai-audit-ledger'

const client = new AuditClient({
  ingestUrl: 'https://your-api-url/audit/events',
  apiKey: 'your-tenant-key'
})

// After your AI makes a decision
await client.logEvent({
  modelVersion: 'gpt-4o',
  inputData: 'the raw text you fed the model',   // hashed locally, never sent
  decision: { recommendation: 'shortlist', score: 94 },
  humanInLoop: false
})
```

---

## Frequently asked questions

**Does our personal data leave our systems?**
No. The SDK hashes sensitive inputs on your side before sending anything. We receive a mathematical fingerprint, not the original content. Names, CVs, and identifiers stay with you.

**What happens if your service goes down?**
The ingest API uses a queue — if there is a temporary disruption, records are held and processed automatically when the service recovers. No records are lost.

**Can we delete a record if we made a mistake?**
No — and that is by design. The tamper-evidence guarantee only works if records cannot be deleted or modified. If you send a record in error, it stays but can be flagged in the decision output.

**How do we know you haven't altered a record?**
Every record is stored in a sealed vault (AWS S3 Object Lock, COMPLIANCE mode). This is a platform-level guarantee from Amazon — not even we can modify or delete it before the retention period ends. The tamper-evidence check in the dashboard compares the queryable copy against this sealed original.

**What is the retention period?**
Seven years by default, which covers the EU AI Act's expected documentation requirements. This can be adjusted.

**How does multi-tenancy work?**
Each customer gets their own API key which maps to a unique tenant ID. Records are isolated — one customer cannot see another's data. Read keys can be scoped to a single tenant or granted admin access.

**Is there a rate limit?**
Yes — 100 requests per minute per tenant by default. This can be increased on request.

**What compliance frameworks does this support?**
The product is designed with EU AI Act Article 12 in mind. The tamper-evidence and data minimisation design also supports GDPR obligations. It is not a certified compliance product — it provides the technical evidence that supports your compliance process.
