# AI Audit Ledger: Versions at a Glance

One-page companion to `VERSION-WALKTHROUGH.md`. Use this when you need the comparison without the narrative.

---

## What this is, in one paragraph

A regulated company uses AI to make decisions about real people. A regulator will eventually ask for evidence of every one of those decisions. The audit ledger captures each decision at the moment it happens, stores it in a way no one can tamper with for seven years, and lets the customer prove later that the log is both unaltered and complete. Runs in AWS. Customers either call our SDK from their code or let an AI agent call our MCP server through Claude Desktop, Cursor, or LangGraph.

---

## Two paths

| | SDK path | MCP path |
|---|---|---|
| Who picks it | Companies writing code that calls an AI model | Companies using AI agents in Claude Desktop, Cursor, or LangGraph |
| What they install | `pip install ai-audit-ledger` (or Node equivalent) | `npx -y audit-ledger-mcp` (configured in their agent client) |
| What they write | Three lines of code per decision | Nothing. The agent calls the tool. |
| Where the hashing happens | Inside their application process | Inside the MCP server child process |

Both paths end up in the same AWS infrastructure. From the cloud side of the wire, they look identical.

---

## What changed at each version

| | 0.1 (initial) | 0.2 (MCP arrives) | 0.3 (today) |
|---|---|---|---|
| SDK available | Yes | Yes | Yes |
| MCP server available | No | Yes | Yes |
| Sandbox mode | No | Yes | Yes |
| MCP tools | n/a | 3 | 4 |
| PII hashing | Plain SHA-256 | Plain SHA-256 | HMAC-SHA256 with customer-held key (plain SHA-256 fallback) |
| Can prove no tampering | Yes | Yes | Yes |
| Can prove no deletion | No | No | Yes |
| GDPR pseudonymisation claim | Weak | Weak | Defensible |
| Listed in official MCP Registry | n/a | Yes (from 0.2.1) | Yes |

---

## What the customer has to do, in three rows

| Path / mode | One-time setup | Per-call |
|---|---|---|
| **SDK (any version)** | Deploy AWS stack. Generate write key in Secrets Manager. Set `AUDIT_INGEST_URL` and `AUDIT_WRITE_KEY` env vars. From 0.3: also generate `AUDIT_HMAC_KEY` and add to env. | `await client.log_decision_async(raw_prompt=..., raw_input=..., decision=..., ...)` |
| **MCP production (0.2+)** | Deploy AWS stack. Generate write + read keys. Add `env` block to agent client config with `AUDIT_API_URL`, `AUDIT_WRITE_KEY`, `AUDIT_READ_KEY`. From 0.3: also `AUDIT_HMAC_KEY`. | Nothing. Agent calls the tools when needed. |
| **MCP sandbox (0.2+)** | `npx -y audit-ledger-mcp` with no env vars. Records go to a shared public tenant. | Nothing. |

---

## Architecture in one sentence

The SDK or MCP server hashes the PII locally (HMAC with the customer's key from v0.3), POSTs the digest plus the decision to API Gateway, which hands off to an Ingest Lambda that validates and queues; an SQS-driven Processor Lambda then allocates a per-tenant sequence number, writes the record to DynamoDB for query and to S3 with Object Lock COMPLIANCE mode for the immutable seven-year copy.

## What happens when something fails

The Processor Lambda gets five attempts via SQS. If all five fail, the message goes to a Dead Letter Queue. A CloudWatch alarm fires, an SNS topic notifies the operator by email, and a DLQ Consumer Lambda publishes structured details (event ID, tenant ID, retry count, payload preview) and notifies the affected tenant via their registered contact. Nothing is lost. Once the operator fixes the cause, the message is replayed from the DLQ.

S3 Object Lock means no one (not the customer, not the operator, not AWS root) can alter or delete a stored record before its retention date. If the DynamoDB copy is tampered with, `verify_decision` detects the mismatch against the S3 copy. From 0.3, `verify_completeness` also detects deleted records as gaps in the per-tenant sequence.

---

## The four MCP tools (0.3)

| Tool | What it does |
|---|---|
| `record_decision` | Log an AI decision. Hashes inputs locally then writes to the ledger. |
| `verify_decision` | Prove a stored record was not altered. Compares the queryable copy against the immutable S3 copy. |
| `verify_completeness` | Prove no records have been deleted. Returns any missing sequence numbers for the tenant. |
| `list_decisions` | Query recent decisions, optionally filtered by time window. |

---

## Where to find each surface

| Surface | Location |
|---|---|
| Main repo (CDK, SDKs, dashboard) | `github.com/shahidh68/audit-ledger` |
| MCP server source | `github.com/shahidh68/audit-ledger-mcp` |
| npm package | `npmjs.com/package/audit-ledger-mcp` (currently 0.3.0) |
| Official MCP Registry listing | `io.github.shahidh68/audit-ledger-mcp` |
| Live sandbox dashboard | `d2pfirb2397ixy.cloudfront.net` |
| Case study | `zyvra.studio/work/audit-ledger.html` |
| Full narrative | `VERSION-WALKTHROUGH.md` in this repo |
| Operations playbook | `RUNBOOK.md` in this repo |
| Technical architecture | `ARCHITECTURE.md` in this repo |
