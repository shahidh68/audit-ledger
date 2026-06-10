# AI Audit Ledger

**Tamper-evident audit infrastructure for AI decisions.** Production AWS stack that produces evidence a regulator can verify, built for EU AI Act Article 12 logging and FCA SS1/23 model risk obligations.

Every AI decision your system makes is recorded once, sealed in S3 Object Lock under COMPLIANCE mode, and queryable for the next 7 years. Records cannot be altered or deleted — not by you, not by AWS, not by the root account. A two-storage cross-check exposes any divergence in seconds.

[License: Apache 2.0](#license) · Python + Node.js SDKs · AWS CDK · 7-year retention by default

> **Companion project — [AI Decision Evidence Hub](https://github.com/shahidh68/evidence-hub).**
> The ledger proves *what happened* and that it wasn't tampered with. The Evidence Hub sits
> *above* it (read-only) and proves *audit-readiness*: for each decision, what evidence is
> present, what's missing, who owns each gap, a 0–100 readiness score, and exportable audit
> packs. Also serverless on AWS (Lambda + DynamoDB). Together they're the
> **AI Audit Ledger family**: [audit-ledger](https://github.com/shahidh68/audit-ledger) ·
> [audit-ledger-mcp](https://github.com/shahidh68/audit-ledger-mcp) ·
> [evidence-hub](https://github.com/shahidh68/evidence-hub).

**[Live demo dashboard →](https://d2pfirb2397ixy.cloudfront.net/?demo=1)** &nbsp;&middot;&nbsp; 30 synthetic decisions you can click through and verify.

<p align="center">
  <img src="./demo.gif" alt="Loan triage demo — two AI agents, human-in-the-loop, three audit events written to the ledger" />
</p>

> Two AI agents (triage and risk) plus a human-in-the-loop reviewer triaging a borderline loan application. Each step writes an independent audit event. The full chain is reconstructable from the audit trail alone.

---

## Why this exists

The EU AI Act came into partial force in February 2025. Article 12 obligations for high-risk AI systems — automatic logging, traceability of outputs, retention of records — apply from **August 2026**. The FCA's SS1/23 imposes parallel evidence requirements for model risk management in UK financial services.

Most teams answer audit requests with a database query and a spreadsheet. That answer has two problems:

1. The records can be edited. There is no proof they were not changed between the decision and the audit.
2. The records contain personal data. The spreadsheet itself becomes a GDPR liability.

This project is the infrastructure layer that fixes both. Decisions are written to an append-only ledger, personal data is hashed locally before transit, and a regulator can verify any record without trusting the operator.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Your system  ─  SDK hashes PII locally, only hashes leave         │
└────────────────────────┬───────────────────────────────────────────┘
                         │ HTTPS POST /audit/events
                         ▼
                ┌─────────────────┐
                │  API Gateway    │ 100 req/s · rate-limited per tenant
                └────┬────────────┘
                     │
            ┌────────┴────────┐
            ▼                 ▼
     ┌──────────────┐  ┌──────────────┐
     │  Ingest λ    │  │  Read λ      │
     │  202 in ~80ms│  │  Tenant scope│
     └──────┬───────┘  └──────┬───────┘
            │                 │
            ▼                 │
     ┌──────────────┐         │
     │  SQS         │         │
     │  DLQ × 5     │         │
     └──────┬───────┘         │
            ▼                 │
     ┌──────────────┐         │
     │  Processor λ │         │
     └──┬────────┬──┘         │
        │        │            │
        ▼        ▼            │
  ┌─────────┐ ┌──────────────────────┐
  │DynamoDB │ │ S3 Object Lock       │
  │ Query   │ │ COMPLIANCE · 7 years │◄── tamper-check compares both
  └─────────┘ └──────────────────────┘
```

Full component inventory, IAM, and configuration values: [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Quick start

Requires AWS credentials with permission to deploy a CDK stack in your account.

```bash
# 1. Deploy the infrastructure
cd infra/cdk
npm install
npx cdk bootstrap            # first time only
npx cdk deploy --context alertEmail=you@example.com

# 2. Populate your tenant API key in Secrets Manager (one-off, see GETTING-STARTED.md step 10)

# 3. Record a decision from Python
pip install -e ./sdk/python
```

```python
import asyncio
from ai_audit_ledger import AiAuditLedgerClient

client = AiAuditLedgerClient(
    ingest_url="https://<api-id>.execute-api.<region>.amazonaws.com/prod/audit/events",
    tenant_api_key="<your-tenant-key>",
)

asyncio.run(client.log_decision_async(
    raw_system_prompt="You are a loan triage assistant...",
    raw_user_input="Applicant: <PII>",            # hashed locally before transit
    model_version="claude-sonnet-4.7",
    ai_decision_output={"decision": "refer_to_human", "score": 0.62},
    human_in_loop=True,
))
```

The same call from Node.js: see [sdk/nodejs/src/index.mjs](./sdk/nodejs/src/index.mjs).

End-to-end example with a real AI workflow: [apps/resume-screener](./apps/resume-screener).

---

## What's in this repo

| Path | What it is |
|---|---|
| [`infra/cdk/`](./infra/cdk) | AWS CDK stack (TypeScript) — API Gateway, 5 Lambdas, SQS, DynamoDB, S3 Object Lock, Secrets Manager |
| [`sdk/python/`](./sdk/python) | Python SDK — async client, local PII hashing, exponential-backoff retry, typed errors |
| [`sdk/nodejs/`](./sdk/nodejs) | Node.js SDK — equivalent interface, ESM |
| [`schemas/`](./schemas) | Shared payload schemas (Python + TypeScript) |
| [`apps/resume-screener/`](./apps/resume-screener) | Reference application — CV triage with full audit integration |
| [`dashboard/`](./dashboard) | Compliance dashboard — browse records, run tamper-check, export CSV |
| [`tests/`](./tests) | Integration tests against deployed environment |
| [`tools/`](./tools) | Operational tooling (reconciler, restore, admin contacts) |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Single technical reference for the deployed system |
| [`DEPLOYMENT.md`](./DEPLOYMENT.md) | Step-by-step deployment guide |
| [`RUNBOOK.md`](./RUNBOOK.md) | Operational procedures, alerting, recovery |
| [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md) | Plain-English explanation for compliance and non-technical readers |

---

## Design decisions worth reading

A handful of choices that distinguish this from a "log to a database and call it audit-grade" implementation.

**S3 Object Lock COMPLIANCE mode over custom hash chaining.** COMPLIANCE mode is a recognised regulatory standard (SEC 17a-4, FINRA, HIPAA). No AWS principal, including the root account, can delete or overwrite a locked object before its retention date. An auditor can understand the guarantee without auditing the code. A custom hash chain would have to be re-audited every time the chain logic changed.

**Two storage layers, not one.** DynamoDB is optimised for queries; S3 is optimised for immutability. The tamper-check endpoint fetches both copies and compares with stable JSON serialisation. If a DynamoDB record is ever altered by a misconfigured process, the S3 copy exposes the discrepancy. Either layer alone could be compromised in plausible failure modes; together they are forensic-grade.

**Per-tenant sequence numbers detect deletion, not just tampering.** Tamper-checking only proves a record that *exists* matches its S3 copy. A row deleted from DynamoDB looks identical to "wrong event_id" without a separate signal. The processor assigns a monotonic `sequence_no` to every successfully stored record (atomic counter in `TenantSequenceTable`). The `GET /audit/verify-completeness` endpoint compares the counter against the rows actually present and returns any sequence numbers that are missing, so a deleted row shows up as a gap rather than a not-found. S3 Object Lock COMPLIANCE mode already prevents S3-side deletion; this closes the DynamoDB-side gap. Limitation: a true race during SQS redelivery can burn a sequence number (counter advances, record is not stored because a parallel write got there first). Burns are emitted as structured log entries with `event: "sequence_burned"` so operators can distinguish them from real deletions.

**SQS between ingest and processor.** The 202 response returns to the caller in ~80ms regardless of downstream pressure. Storage writes happen asynchronously with up to 5 retries before a message lands in the DLQ. Customer code is never blocked on a slow PutObject.

**PII hashing in the SDK, not the API.** Raw personal data never leaves the customer's environment. The API stores keyed hashes of inputs and prompts (HMAC-SHA256 keyed off a per-tenant secret the SDK reads from `AUDIT_HMAC_KEY`), the structured decision output, and metadata. The raw input is never sent. Keyed hashing matters because plain SHA-256 of a low-entropy value like a name or email is brute-forceable in seconds, which under ICO and EDPB guidance makes the digest still personal data. HMAC with a tenant-held key makes the value non-reversible by anyone who does not hold the key, which is what regulators expect for pseudonymisation. For backwards compatibility, the SDKs and MCP server fall back to plain SHA-256 if `AUDIT_HMAC_KEY` is unset and emit a one-time deprecation warning; existing integrations keep working unchanged.

**Reserved Lambda concurrency on the Processor (10).** During a spike, the SQS queue absorbs the burst rather than consuming the entire account's Lambda concurrency budget. Other functions in the account stay responsive.

**Secrets Manager for API keys, not environment variables.** Environment variables appear in CloudFormation outputs, Lambda configuration pages, and any tool that lists Lambda settings. Secrets Manager keeps the values off those surfaces and gives you rotation without redeployment — both Lambdas cache the key map and invalidate on miss.

---

## What this is not

- **Not legal advice.** This is infrastructure that produces compliance evidence. Whether that evidence satisfies your specific obligations under the EU AI Act, FCA SS1/23, GDPR, SOC 2, or any other framework is a question for your legal and compliance teams.
- **Not a substitute for a model risk audit.** This records what the AI did, not whether it was right.
- **Not a bias or fairness testing tool.** It is the storage layer underneath whatever testing you already do.
- **Not multi-region by default.** The CDK stack deploys to a single region. Cross-region replication is a follow-on for organisations with regulatory geographic requirements.

---

## Known limits

- Admin reads use a DynamoDB `Scan` with optional timestamp filter. Fine to roughly 10M records; beyond that, plan to mirror to OpenSearch or use a dedicated analytics store for cross-tenant queries.
- The reconciler tooling assumes the DynamoDB record is the source of truth for routine integrity checks. A complete forensic check involves re-fetching from S3, which the tamper-check endpoint already does on a per-record basis.
- Rate limiting is per-tenant, per-minute, on a DynamoDB atomic counter. Bursts within the same second are not smoothed — they are accepted up to the per-minute ceiling.

---

## Roadmap

- MCP server wrapper — let any LangGraph / Claude / Cursor agent record decisions as a tool call.
- Cross-region replication module — optional CDK construct for jurisdictional requirements.
- OpenSearch mirror for high-volume tenants — read path for analytics workloads.
- Verifiable Merkle anchoring — daily root published to a public location for an additional, externally-checkable integrity proof.

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE). The patent grant is intentional; this project sits adjacent to enterprise legal review and the explicit grant matters there.

---

## Author

Built by [Shahid](https://github.com/shahidh68). Available for Principal AI Engineering and Head of AI Engineering roles, and fractional advisory engagements, in UK regulated fintech.

Case study with design rationale and operational metrics: *[link — to be added at launch]*

Contact: *[email — to be added at launch]*
