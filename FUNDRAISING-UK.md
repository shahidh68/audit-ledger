# AI Audit Ledger — UK Fundraising Guide

This document covers the most efficient path to raising seed investment in the UK for this product. It is written for a pre-revenue, product-built stage company targeting angel investors.

---

## What you are raising and why

You need seed capital to cover:

- **SOC 2 audit** — approximately £15,000–£25,000
- **Legal** — DPA template, terms of service, lawyer review — approximately £5,000–£10,000
- **Runway** — time to reach first paying customers

A round of **£100,000–£300,000** is the right target at this stage. That is an angel round, not a VC round. VCs typically require revenue or a much larger raise — angels move faster and are the right fit here.

---

## Step 1 — Incorporate first

You need a **UK limited company** before anyone can invest.

- Register at **companieshouse.gov.uk**
- Takes 24 hours online
- Costs £12
- You will need a registered UK address

Do this before any investor conversations.

---

## Step 2 — Apply for SEIS advance assurance (critical)

This is the single most important thing you can do before approaching any UK investor.

**What SEIS is:**
SEIS (Seed Enterprise Investment Scheme) is a UK government scheme that gives your investors **50% income tax relief** on what they put in. On a £50,000 investment, HMRC effectively refunds £25,000 of the investor's tax bill. It dramatically lowers their risk and makes them far more likely to commit.

**What to do:**
- Apply to HMRC for advance assurance before you start raising
- Free to apply
- Takes approximately 4–8 weeks
- Once approved, state "SEIS eligible" in every investor conversation

Most UK angels at this stage will not write a cheque without it. Getting advance assurance before your first investor meeting removes the single biggest friction point in early-stage UK fundraising.

Search **gov.uk/guidance/venture-capital-schemes-apply-for-the-seed-enterprise-investment-scheme** to start the application.

---

## Step 3 — Get one design partner first

Before talking to investors, get one company — even on a free pilot — to say in writing: *"we are testing this and would pay for it."*

A one-paragraph email from a compliance lead or CTO at a real company is worth more in investor conversations than 20 slides. It proves the problem is real and that someone other than you believes in it.

**Where to find them:**
- LinkedIn outreach to compliance leads, CTOs, and heads of legal at mid-size HR-Tech and fintech companies
- Search for companies that have publicly mentioned EU AI Act preparation
- Legal and compliance forums, RegTech events

**What to ask for:**
Not money. Ask for a 20-minute call about their current AI logging setup. If the problem resonates, offer a free pilot in exchange for feedback. Get their reaction in writing — even an email saying "this looks interesting, we'd like to trial it" is enough to open investor conversations.

---

## Step 4 — Build a short deck

Keep it to **10 slides maximum**. Investors at this stage are backing the problem and the founder, not a detailed financial model.

| Slide | Content |
|---|---|
| **1. Problem** | The EU AI Act logging gap — companies using AI in hiring, credit, and customer decisions face mandatory audit trail requirements |
| **2. Why now** | August 2026 enforcement deadline for high-risk AI systems. Fines up to €15 million or 3% of global turnover |
| **3. Solution** | What you built — one-sentence description |
| **4. How it works** | One architecture diagram — fast API, tamper-evident storage, privacy-first design |
| **5. Who buys it** | ICP: HR-Tech, fintech, customer decision platforms. Buyer: CTO + compliance lead |
| **6. Traction** | Design partner name (if you have one), product built and deployable, documentation complete |
| **7. Business model** | Per-tenant pricing, usage-based, subscription options |
| **8. Market size** | Number of companies in scope for EU AI Act high-risk obligations |
| **9. The ask** | £X for Y months to reach Z milestone (first paying customer, SOC 2 certified, N pilots) |
| **10. Team** | Why you are the right person to build this |

**What to avoid in the deck:**
- Detailed financial projections at this stage — no one believes pre-revenue numbers
- More than one diagram per slide
- Legal disclaimers on every page
- The word "revolutionary"

---

## Step 5 — Where to find UK angels

### Fastest routes

**Angel Investment Network** (angelinvestmentnetwork.co.uk)
Post your raise and angels come to you. Large UK network, good for SEIS-eligible rounds.

**Seedrs** (seedrs.com)
Equity crowdfunding platform. Good for SEIS raises. Builds a community of smaller investors alongside a lead angel. Takes 6–10 weeks to run a campaign but generates visibility.

**Crowdcube** (crowdcube.com)
Similar to Seedrs. Strong brand recognition with UK retail investors.

**LinkedIn direct outreach**
Search for angels who have backed RegTech, LegalTech, compliance SaaS, or B2B infrastructure. Look at the portfolios of RegTech-focused angels and message them directly with a one-paragraph summary.

**Local angel networks**
- London Business Angels (lbangels.co.uk)
- Cambridge Angels (cambridgeangels.net)
- Midlands Engine Investment Fund — if based outside London
- Scottish Investment Bank — if Scotland-based

### The most important rule

**Warm introductions beat cold outreach by a factor of 10.**

Before emailing any investor directly, go through your personal and professional network and ask: *"do you know anyone who invests in early-stage B2B tech or compliance software?"* One introduction from a mutual contact will get a faster and warmer response than 50 cold emails.

---

## Step 6 — What to say in the first conversation

Do not lead with the technology. Lead with the problem.

**Opening:**
*"Companies using AI in hiring and credit decisions face mandatory logging requirements under the EU AI Act from August 2026. The fine for non-compliance is up to €15 million. Most companies have no compliant audit trail today. We built the infrastructure to fix that — engineers integrate it in less than a day."*

Then show the product. Then ask: *"Does this look like something you would want to learn more about?"*

**If they ask about competition:**
General logging tools (Datadog, Splunk) were not built for audit evidence — they can be edited. ML governance platforms are expensive and complex. We are specifically built for the tamper-evidence requirement at a price point that mid-size companies can afford.

**If they ask about the technology:**
The record is stored in a sealed vault (S3 Object Lock) — the same standard banks use for financial regulatory records. It physically cannot be altered or deleted for 7 years. When a regulator asks "prove this wasn't changed," we can answer that in one click.

**At the end of every meeting, ask:**
*"Who else do you think should hear about this?"* — even a no can generate introductions.

---

## Step 7 — Running the round

Once you have one or two angels interested, move quickly. Angel rounds lose momentum if they drag on.

**Typical process:**

1. **Term sheet** — agree valuation, amount, and SEIS eligibility. Keep it simple at this stage. Use a standard SEIS-compatible subscription agreement — a lawyer can produce this for £1,000–£2,000.
2. **Due diligence** — angels at this stage typically review the product, check the team, and read the documentation. Having the architecture docs, one-pager, and investor brief ready (already done) speeds this up significantly.
3. **Closing** — funds transferred, shares issued, SEIS certificates applied for via HMRC.

**Valuation guidance:**
Pre-revenue B2B SaaS/infrastructure in the UK typically raises at £500k–£1.5m pre-money valuation at this stage. The EU AI Act angle and the August 2026 deadline are strong justifications for the higher end of that range.

---

## Parallel track — Innovate UK grants

Innovate UK runs grant competitions for technology companies. Grants are **non-dilutive** — you do not give away any equity.

A grant of £50,000–£100,000 would cover your SOC audit and legal costs without giving away any ownership. This is worth pursuing in parallel with the angel raise.

**Where to look:**
- **iuk.ktn-uk.org** — search for open competitions in the AI governance, regulatory technology, or compliance categories
- **Horizon Europe** — UK companies regained access; check eligibility for EU research funding
- **DESNZ / DSIT programmes** — Department for Science, Innovation and Technology runs targeted AI programmes

Grant applications take 2–4 weeks to write and 6–12 weeks for a decision. Start one application now while the raise is running.

---

## Realistic timeline

| Week | Activity |
|---|---|
| 1–2 | Incorporate as UK Ltd, begin SEIS advance assurance application |
| 3–6 | Outreach for design partner, build investor deck, identify target angels |
| 6–8 | SEIS advance assurance received from HMRC |
| 6–10 | Design partner pilot agreed |
| 8–12 | First investor meetings |
| 10–16 | First commitments, round building |
| 14–20 | Round closes, funds received |

Running the Innovate UK grant application in parallel with weeks 3–10 adds no significant time cost.

---

## What to avoid

**Approaching VCs too early**
Most UK VCs want £1M+ rounds with demonstrable revenue traction. At this stage you will spend months in a slow process and likely receive a no. Angels move in weeks, not months.

**Raising without SEIS advance assurance**
Leaves money on the table and slows every investor decision. Get it before the first meeting.

**Raising before any design partner evidence**
Possible, but harder. Even one unpaid pilot agreement changes the conversation from "would anyone want this?" to "people want this."

**Over-engineering the deck**
A 25-slide deck with complex financial models signals that you do not understand what early-stage investors need. Ten clear slides and a working product demo beat a polished presentation every time.

**Taking the first offer without shopping it**
Talk to at least 5–10 angels before committing to terms. You want competitive tension — even informally — to achieve a fair valuation.

---

## Summary

| Priority | Action |
|---|---|
| **Immediate** | Incorporate as UK Ltd |
| **Immediate** | Apply for SEIS advance assurance |
| **Week 1–4** | Secure one design partner (free pilot is fine) |
| **Week 2–4** | Build 10-slide deck |
| **Week 6+** | Begin investor conversations |
| **Parallel** | Apply for one Innovate UK grant |

The EU AI Act enforcement deadline creates genuine urgency in the market. That urgency is your strongest asset in investor conversations — use it.

---

*This document does not constitute financial or legal advice. Consult a solicitor for share structure, investment agreements, and SEIS eligibility confirmation before raising.*
