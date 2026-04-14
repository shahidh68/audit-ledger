# Beta test invitation — AI Audit Ledger

Use this to ask people if they want **early access** and to **try the product** (design partners / technical beta). Replace bracketed text.

**Product (one line):** A managed service that logs **AI decision events** (model, decision, hashes—not raw PII) to **tamper-evident** storage, with a **dashboard** and exports for audits. See `HOW-IT-WORKS.md` and `LAYMAN-GUIDE.md` for detail.

---

## Short version (DM / email)

> Hi [Name],  
>  
> I’m building **AI Audit Ledger** — a service for teams that need a **defensible audit trail** when their AI makes decisions (what model, what outcome, proof the record wasn’t altered). Early stage; I’m looking for **beta testers** who might integrate the API or use the dashboard and tell me what’s missing.  
>  
> If you’re interested, reply **yes** and I’ll send how to get access, docs, and where to send feedback.  
>  
> Thanks,  
> [Your name]

---

## Longer version (email)

**Subject:** Beta / design partner — AI Audit Ledger (AI decision audit trail)

> Hi [Name],  
>  
> I’m opening a **closed beta** for **AI Audit Ledger**.  
>  
> **What it does:** Each time your system makes an **AI-driven decision**, you send us a small **event** (model id/version, decision payload, **hashed** inputs—not raw personal data). We store it so it’s **queryable** and **tamper-evident** (locked copy vs live index check), with a **browser dashboard** and CSV-style export for compliance/regulator-style questions.  
>  
> **Who it’s for:** Teams building **AI into products** who already worry about **traceability**, **EU AI Act–style** accountability, or “show me the trail for this customer.”  
>  
> **What beta means:** Early access; things may change; you’ll need to be comfortable with **AWS-hosted** APIs and **API keys** (see `DEPLOYMENT.md` / `SETUP-AND-ARCHITECTURE.md` in the repo). I’ll share **[onboarding steps / staging URL / tenant setup]** once you’re in.  
>  
> **What I’d ask from you:** Honest feedback on **integration effort**, **dashboard usability**, and **what your legal/compliance** person would still want. Rough time: **[e.g. a few hours engineering + optional compliance review]**.  
>  
> **Data:** We design around **hash-first** payloads; you control what leaves your environment—see `HOW-IT-WORKS.md`. A **DPA** may apply if any personal data could be involved—treat beta as **[test data / non-production]** unless we’ve signed terms.  
>  
> Interested? Reply **yes** and I’ll follow up with next steps.  
>  
> [Your name]  
> [Company / link]

---

## Optional bullets (attach to set expectations)

- **Stack:** HTTP ingest API, optional **Python/Node SDKs**, compliance **dashboard** (static UI).  
- **Not:** A replacement for your full ML observability stack unless that’s how you use it—it’s focused on **immutable audit records**.  
- **Beta risk:** Breaking changes possible; no production SLA unless agreed in writing.  
- **Feedback channel:** [email / Slack / GitHub Discussions / form — you choose].

---

## One-liner (social / footer)

> Building **AI Audit Ledger** — tamper-evident logging for AI decisions. Looking for **beta / design partners**; DM if interested.

---

## Relaxed / friendly version (DM or email) — with EU AI Act Article 12

Use this tone when you want to sound human, not corporate. **Article 12** of the EU AI Act deals with **record-keeping and automatic logging** for **high-risk** AI systems — the product is meant to **support** that kind of traceability; it does **not** by itself guarantee legal compliance (scope, risk class, and full obligations depend on your system — legal should confirm).

> Hey — random ask: would you be up for trying something we’re building while it’s still early?  
>  
> It’s called **AI Audit Ledger**. Basically, every time your AI makes a call, you drop in a tiny log line: which model, what it decided, when — plus a **fingerprint** of what went in (not the actual CV or file). We keep that log in a way that’s **really hard to mess with after the fact**, and there’s a **simple dashboard** to poke around and export stuff if you ever need to show someone “here’s what happened.”  
>  
> If you’re in the EU AI Act world, **Article 12** is the bit about **keeping proper automatic logs** for **high-risk** systems — we’re aiming to make that kind of **record-keeping and traceability** a lot less painful (your compliance person still needs to say you’re in scope and happy with the setup).  
>  
> We’re only looking for a handful of teams who actually care about **being able to trace AI decisions** and don’t mind **kicking the tyres** and telling us what’s confusing or missing. Totally fine if now’s not the time — if it sounds interesting though, just reply and we’ll send you how to get going.  
>  
> Thanks either way,  
> [Your name]

---

*Keep claims aligned with your actual deployment and legal position; see `GO-TO-MARKET.md` for gaps (e.g. SOC 2, self-serve onboarding).*
