# Is Your AI Making Decisions You Can't Explain?

## The EU AI Act has a logging requirement. Most companies aren't ready for it.

If your company uses AI to make or influence decisions about people — hiring, credit, insurance, customer service — **Article 12 of the EU AI Act requires you to keep logs of those decisions**.

Not just any logs. Logs that are:
- **Tamper-evident** — someone can't quietly edit them after the fact
- **Detailed enough** to reconstruct what happened and why
- **Private enough** to not become a GDPR liability in themselves

The fine for non-compliance: **up to €15 million or 3% of global annual turnover** — whichever is higher.

---

## The problem most teams hit

When compliance asks *"show me every AI decision made about this candidate in the past 12 months"*, the engineering team opens a database, runs a query, and hands over a spreadsheet.

That spreadsheet has two problems:

1. **It can be edited.** There's no proof the records weren't changed between the decision being made and the audit happening.
2. **It contains personal data.** Names, CVs, identifiers — now sitting in a compliance report being emailed around.

Standard databases weren't built for audit-grade evidence. They were built for application data.

---

## What AI Audit Ledger does

We provide a simple API your engineers integrate in hours. When your AI makes a decision, you send us a record. We store it in a **cryptographic ledger** — the same technology used in financial audit trails — so every record has a verifiable history.

**What gets stored:**
- Which AI model made the decision, and which version
- A hash of the input (not the raw input — so no personal data leaves your system)
- The structured decision output
- Whether a human reviewed it
- A timestamp that can't be backdated

**What you get back:**
- A tamper-evident audit trail you can show a regulator
- Revision history for every record — proof nothing was changed
- A read API your compliance team can query without asking engineering

---

## Who this is for

Mid-size companies using AI in:
- **Hiring and recruitment** (CV screening, candidate scoring, interview analysis)
- **Financial decisions** (credit scoring, fraud detection, loan approvals)
- **Customer decisions** (churn prediction, pricing, service routing)

If a regulator knocked on your door tomorrow and asked *"show us how your AI made these decisions"* — could you answer confidently?

---

## How it works in practice

```
Your AI system
     │
     ▼
Hash sensitive inputs locally  ← personal data never leaves you
     │
     ▼
Send decision record to our API  (takes ~50ms, non-blocking)
     │
     ▼
Stored in cryptographic ledger  ← tamper-evident, revision history intact
     │
     ▼
Query anytime via read API or dashboard
```

Integration takes a developer **less than a day** using our Python or Node.js SDK.

---

## The compliance gap is closing fast

The EU AI Act began enforcement in **February 2025** for prohibited AI systems, with **high-risk system obligations** (including logging) applying from **August 2026**.

Companies that start now have time to do it properly. Companies that wait will be scrambling — or paying fines.

---

## What we're looking for

We're working with a small number of companies as **design partners** — early access in exchange for feedback on what compliance teams actually need.

No cost. No commitment. Just a conversation about your current setup and whether this solves a real problem for you.

**If you're dealing with this problem, I'd like to talk.**

[Contact details]

---

*AI Audit Ledger is technical infrastructure for compliance evidence. It supports your compliance process — it is not legal advice and does not guarantee regulatory outcomes. Consult your legal team on your specific obligations under the EU AI Act.*
