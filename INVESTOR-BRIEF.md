# AI Audit Ledger — Investor brief

**Confidential — for discussion purposes**

This note summarises **what the product is**, **why it matters commercially**, and **what an investor should validate** in diligence. It is not a forecast and does not include financial projections unless your team adds them.

---

## 1. One-line pitch

**AI Audit Ledger** is a B2B infrastructure product that lets HR technology companies **prove how their AI systems made decisions**—with **cryptographically durable logs** and **privacy-first design**—so they can meet rising regulatory expectations (notably EU AI Act–style transparency and traceability) without storing raw personal data in the audit trail.

---

## 2. The problem

- **Regulators and enterprise buyers** increasingly expect **accountability** for automated decisions that affect people (hiring, scoring, recommendations).
- **“We logged it in a database”** is often **not enough** under scrutiny: conventional databases can be **changed** by administrators; logs alone may not demonstrate **integrity** over time.
- **Storing full prompts, resumes, or names** in a third-party audit system creates **GDPR and data-minimisation** problems. Vendors need **evidence of decision-making** without becoming a **warehouse of sensitive personal data**.

---

## 3. The solution (product)

AI Audit Ledger provides an **API and client SDKs** so customers can:

1. **Hash sensitive inputs locally** (for example resume text or identifiers) and send only **digests** to the audit service—supporting **data minimisation**.
2. **Record** model identity, prompt hash, input hash, structured decision output, and whether a human reviewed the outcome—supporting **traceability**.
3. **Store** events in an **immutable archive** (S3 Object Lock in COMPLIANCE mode) so records are **physically impossible to alter or delete** for the retention period — supporting **integrity** claims for compliance conversations. S3 Object Lock is a recognised standard for regulatory record-keeping (SEC 17a-4, FINRA, HIPAA).
4. **Read back** events and run **tamper-evidence checks** for audits, exports, and “show your work” workflows — the read API compares the queryable DynamoDB record against the locked S3 original and reports whether they match.

The reference implementation uses **API Gateway**, **SQS** (fast acceptance, async persistence), **Lambda**, **DynamoDB** (queryable index), and **S3 Object Lock** (immutable WORM archive), with a **compliance dashboard** for officers who need tables, verification views, and exports.

---

## 4. Who buys it (ICP)

**Initial commercial focus (as designed):** **HR-Tech and recruiting platforms** that embed AI (matching, screening, scoring) and must answer to **enterprise procurement**, **legal**, and **regulators**.

**Buyer personas:** CTO / VP Engineering (integration), Legal / Compliance (assurance), Product (roadmap risk).

**Why they pay:** Reduces **legal and reputational risk**, speeds **enterprise sales cycles** where AI governance questionnaires appear, and turns “trust us” into **demonstrable process**.

---

## 5. Why now

- The **EU AI Act** and similar frameworks globally push **documentation, logging, and oversight** for high-impact uses of AI.
- **Enterprise HR** is sensitive: decisions affect careers; **audit readiness** is becoming a **table-stakes** requirement for vendors selling to banks, governments, and large employers.

---

## 6. Differentiation (what to test in diligence)

**Potential advantages** (to validate, not assume):

| Theme | Claim to validate |
|--------|---------------------|
| **Integrity story** | Immutable ledger semantics vs append-only logs in a standard DB; what exactly is proven to whom? |
| **Privacy posture** | Client-side hashing + contract of no raw PII in payload; how is misuse prevented? |
| **Performance** | Queue-backed ingest for sub-second API behaviour under load; real benchmarks needed. |
| **Time to integrate** | SDKs (Python, Node) vs bespoke integration; developer experience and docs. |

**Honest boundary:** “Compliance” is **process + law + evidence**; no software **guarantees** regulatory outcomes. The product should be positioned as **strong technical evidence** and **operational discipline**, not a certificate.

---

## 7. Business model (typical patterns — to be confirmed)

Common patterns for API-led B2B infrastructure:

- **Per-tenant** API keys and **usage-based** pricing (events ingested, read API calls, retention window).
- **Tiered** plans by volume, support, and **SLA**.
- Optional **professional services** for onboarding and control mapping.

Your team should attach **actual pricing hypotheses** and **unit economics**; this document does not invent numbers.

---

## 8. Technology and roadmap (high level)

- **Shipped in repo:** Schemas, Python and Node SDKs, AWS CDK stack (ingest, process, read), DynamoDB + S3 Object Lock storage, Secrets Manager key management, per-tenant rate limiting, compliance dashboard, deployment and architecture docs.
- **Natural extensions:** Formal SOC 2-style controls, SIEM exports, multi-region, longer retention tiers, self-serve tenant onboarding.

---

## 9. Risks and open questions (investor diligence)

1. **Storage architecture** — The system uses **S3 Object Lock** (WORM, COMPLIANCE mode) as the tamper-evidence layer, replacing Amazon QLDB which was discontinued in July 2025. S3 Object Lock is a mature, widely-recognised compliance standard with no announced end-of-life risk.
2. **TAM / SAM** — Depends on how narrowly you define HR-Tech vs all “high-risk” AI; market sizing should be **bottom-up** (accounts × price × usage).
3. **Competition** — General observability (Datadog-class), **ML governance platforms**, and **consulting-led** compliance. Positioning must be sharp: **evidence-grade audit trail** vs generic monitoring.
4. **Sales cycle** — Security reviews, DPAs, and **subprocessor** questions; enterprise readiness is a product in itself.
5. **Liability framing** — Marketing must avoid **over-claiming**; legal review of **warranties** and **indemnities** is material.

---

## 10. What we would expect to see in a data room (when raising)

- **Architecture and security** overview (this repo’s docs are a starting point: `SETUP-AND-ARCHITECTURE.md`, `DEPLOYMENT.md`).
- **Privacy** stance: data flows, subprocessors, retention, customer responsibilities (hashing client-side).
- **Pilot design**: 2–3 design partners, success metrics (e.g. time to integrate, audit artefacts produced).
- **Financial model**: assumptions explicit; sensitivity on usage and infra cost (especially ledger storage and API volume).

---

## 11. Summary

AI Audit Ledger targets a **real and growing** pain: **defensible AI decision records** under **tight privacy constraints**. The technical story—**hash-first ingestion**, **queue-backed API**, **ledger storage**, **read APIs for audit**—is coherent; commercial success depends on **enterprise trust**, **clear positioning**, **disciplined claims**, and a **credible plan** for scale and cloud dependencies.

---

*For internal use. Numbers, customers, and forward-looking statements to be supplied by the company.*
