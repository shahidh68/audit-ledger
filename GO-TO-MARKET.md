# AI Audit Ledger — Go-to-market plan

**Beta outreach:** copy-paste invitations for design partners / testers are in [`BETA_TEST_INVITE.md`](./BETA_TEST_INVITE.md).

This document turns the **technical product** into a **market path**: what you can sell now, what to build next, who to talk to first, and how to de-risk the business. It pairs with [INVESTOR-BRIEF.md](./INVESTOR-BRIEF.md) (why it matters) and [LAYMAN-GUIDE.md](./LAYMAN-GUIDE.md) (how it works).

---

## 1. Where the product stands today (honest inventory)

**You have (strong foundation):**

- A clear **value proposition**: traceable AI decisions with **hash-first** payloads and **tamper-evident** storage.
- **Ingest + async persistence**: API Gateway → ingest Lambda → SQS → processor → DynamoDB + S3 Object Lock.
- **Read path**: list logs and **tamper-evidence checks** for an `event_id` (compares DynamoDB record against locked S3 original).
- **Multi-tenant isolation**: every record scoped to a tenant_id; read keys are tenant-scoped or admin.
- **Secrets Manager** key management with automatic cache invalidation for key rotation.
- **Per-tenant rate limiting** via DynamoDB atomic counters.
- **Compliance dashboard**: static HTML, no install, opens in any browser.
- **SDKs** (Python, Node) aligned with “don’t send raw PII.”
- **Infrastructure as code** (CDK) and **full documentation suite** (deployment, architecture, getting started, investor brief, one-pager).

**Remaining gaps for commercialisation:**

- **Commercial wrapper**: website, DPA template, SLA tiers, support channel, status page.
- **SOC 2**: technical controls are in place; formal audit and certification still needed for enterprise procurement.
- **Self-serve tenant onboarding**: adding a customer currently requires manual AWS Console steps — fine for first 10 customers, needs automation beyond that.
- **Monitoring / alerting**: CloudWatch alarm on DLQ not yet configured.

Use this list as your **product backlog** and **sales readiness checklist**.

---

## 2. What “minimum sellable” means

**MVP for first paying design partners** (not necessarily self-serve global SaaS):

| Capability | Why it matters |
|------------|----------------|
| Stable **ingest API** + **SDK** | Engineers integrate in days, not months. |
| **Retention** and **access** policy in writing | Legal can sign off. |
| **Read API** or minimal **dashboard** for compliance | Someone non-engineering can pull an audit trail. |
| **Export** (CSV at minimum) | Fits RFP language (“evidence pack”). |
| **Runbook**: incident, key rotation, DLQ | Enterprise security questionnaires. |

You do **not** need perfect self-serve billing on day one; **invoice + manual onboarding** for 2–5 pilots is normal.

---

## 3. Who to sell first (ICP and wedge)

**Primary ICP (as designed):** HR-Tech / recruiting platforms using AI for matching, screening, or scoring.

**Why start here:** They already feel **procurement + GDPR + AI governance** pressure; they have **clear integration points** (after model inference); budgets exist for **risk reduction**.

**First conversations (titles):**

- **CTO / VP Engineering** — integration effort, latency, reliability.
- **Head of Compliance / Legal** — subprocessors, data flow, retention, “what do we get in an audit?”
- **Product / GM** — roadmap risk, enterprise deals blocked by questionnaires.

**Wedge message (plain English):**  
“We give you a **defensible audit trail** for AI decisions: **fast API**, **no raw CVs in our log**, and **ledger history** so you can show **what was decided and that records weren’t quietly edited**.”

Avoid promising **“EU AI Act certified”**; say **evidence and process** (see investor brief).

---

## 4. Phased plan (practical)

### Phase A — Validate (4–6 weeks)

**Goal:** 10–15 qualified conversations, **3 serious follow-ups**, **1 pilot letter** (even unpaid).

**Activities:**

- Build a **one-pager** + short deck (problem, architecture diagram, security posture, what’s in / out of scope legally).
- **Outbound** to HR-Tech founders and compliance leads; ask for **20-minute** architecture reviews, not “buy now.”
- Run **one internal pilot**: ingest synthetic events end-to-end, generate a **sample audit export** and **history screenshot** (even from API JSON).

**Exit criteria:** You can explain **integration steps** in under 10 minutes and you have **written feedback** from at least two potential buyers.

### Phase B — Pilot (6–12 weeks)

**Goal:** **1–3 design partners** using production-like traffic (or shadow mode).

**Activities:**

- Harden **read path** for **multi-tenant** (tenant id in stored document + read scoped by tenant API key or JWT).
- Add **minimal dashboard** or **hosted Postman collection + export script** if you need speed.
- **DPA** draft, **subprocessor list**, **retention** default, **support** email.
- Weekly **office hours** with pilot engineers.

**Exit criteria:** Partner says they would **pay** (amount TBD) or introduces you to **procurement** with intent.

### Phase C — First revenue and repeatability (ongoing)

**Goal:** **Paid** contracts, repeatable **onboarding** (runbook + checklist), **pricing** you can quote without a custom spreadsheet every time.

**Activities:**

- Stripe / usage metering **or** annual contracts with **committed event volume**.
- **SOC 2** path if enterprise demands it (often after first logos).
- Marketing site: **developer docs**, **security page**, **contact sales**.

---

## 5. Packaging and pricing (how to think about it)

**Packaging:**

- **Core:** Ingest + storage + read API + SDKs.
- **Add-ons:** Longer retention, dedicated support, VPC / private connectivity (later), **professional services** for control mapping.

**Pricing levers (pick 2–3 to start):**

- **Per million events** ingested (simple for engineering buyers).
- **Per tenant / per environment** (dev vs prod).
- **Platform fee** + usage (if you need predictable revenue early).

**Rule of thumb:** Early deals are often **\$Xk–\$Yk / month** flat + usage cap until you learn curves—your numbers depend on pilot feedback.

---

## 6. What to build next (prioritised for GTM)

1. **DLQ CloudWatch alarm** — know immediately if records are failing to save.
2. **Public developer docs** (hosted): quickstart, schema, error codes, rate limits.
3. **Commercial wrapper**: DPA template, SLA definition, support email, status page.
4. **SOC 2 Type I** path — controls are in place technically; engage an auditor.
5. **Self-serve tenant onboarding** — automate key generation and secret updates.

---

## 7. Metrics that matter (before vanity metrics)

| Metric | Why |
|--------|-----|
| **Time to first successful ingest** (pilot) | Developer experience |
| **% of pilot integrations completed** in N weeks | Sales + product fit |
| **Ingest success rate** / **DLQ rate** | Reliability story |
| **Compliance stakeholder “would recommend”** (qualitative) | Buyer you actually need |

---

## 8. Summary

**Fastest path to market** is not “finish every feature.” It is: **narrow ICP**, **3 pilots**, **hard multi-tenant read + export**, **clear legal wrapper**, and **credible infrastructure story**—then **first paid deals** and iterate.

Use this file as a living plan: date each phase, note actual pilot names internally, and revise **pricing** and **build order** after the first five customer calls.
