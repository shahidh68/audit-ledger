# AI Audit Ledger: Version Walkthrough

A plain-English reference covering how the audit ledger works at each released version, the two installation paths a customer can take (SDK or MCP server), what the customer has to do for each, and how a recorded decision actually travels through the system end to end including what happens when something fails.

This is the document to read before explaining the project to someone who has not seen it before. Each section is self-contained, so you can jump straight to the version you care about.

---

## Contents

1. [The big picture in one paragraph](#1-the-big-picture-in-one-paragraph)
2. [Two ways a customer uses this: SDK or MCP](#2-two-ways-a-customer-uses-this-sdk-or-mcp)
3. [Version 0.1: the initial release](#3-version-01-the-initial-release)
4. [Version 0.2: the MCP server arrives](#4-version-02-the-mcp-server-arrives)
5. [Version 0.3: keyed hashing and completeness verification](#5-version-03-keyed-hashing-and-completeness-verification)
6. [Architecture flow, end to end, including failures](#6-architecture-flow-end-to-end-including-failures)
7. [When things go wrong: the DLQ, the alerts, the recovery](#7-when-things-go-wrong-the-dlq-the-alerts-the-recovery)
8. [Cheat sheet: what the customer has to do, by version and path](#8-cheat-sheet-what-the-customer-has-to-do-by-version-and-path)

---

## 1. The big picture in one paragraph

A regulated company is using AI to make decisions about real people. Loan approvals. Job applications. Insurance claims. Eighteen months from now an EU AI Act regulator will turn up and ask for evidence of every decision the AI made. The audit ledger is the system that captures every one of those decisions at the moment it happens, stores it in a way that cannot be tampered with or deleted, and lets the regulator (or anyone authorised) verify it later. The whole thing runs in AWS. Customers either call our SDK from inside their own application, or they let an AI agent call our MCP server with no code change at all. Either way, the decision ends up locked in a place no one can alter for seven years.

---

## 2. Two ways a customer uses this: SDK or MCP

The customer picks one. They do not need both. Which one they pick depends on how their AI is wired up.

**The SDK path** is for companies whose engineers are writing code. Their application has a function that calls an AI model, gets a decision back, and acts on it. They add three lines of code: import the SDK, instantiate it with their API key, call `log_decision` after every AI decision. Their developers like this because it is just a Python (or Node) package they install with pip (or npm). It runs inside their existing application, no extra process needed.

**The MCP path** is for companies whose AI is wired up as an agent using the Model Context Protocol. That is the increasingly common setup where the AI lives in Claude Desktop, Cursor, a LangGraph workflow, or a custom agent runtime. The agent calls "tools" the way ChatGPT calls plugins. We expose the audit ledger as a tool the agent can call. The customer drops a single config block into their MCP client and the agent now has the ability to record decisions, verify them, and check the log is complete. The engineer never writes code.

Both paths end up in the same place: a record of the decision lands in our AWS infrastructure, ready for a regulator to inspect.

---

## 3. Version 0.1: the initial release

This was the foundation. Shipped in early 2026.

### What was in it

- AWS infrastructure (API Gateway, Lambdas, SQS, DynamoDB, S3 with Object Lock)
- Python SDK on PyPI
- Node SDK in the repo for direct import
- A web dashboard for inspecting records and running tamper checks
- A LangGraph demo showing how an agent can use the SDK to log decisions

### What was not in it yet

- No MCP server
- PII hashing used plain SHA-256, which is fine for tamper-evidence but not strong enough on its own for the GDPR pseudonymisation claim
- No way to prove the log was complete (only that any given record was unchanged)

### What the customer had to do (SDK path only)

1. **Deploy the AWS stack.** Run `cdk deploy` from the project, point it at their AWS account. Took about 15 minutes the first time. This created their API Gateway, their Lambdas, their tables, their S3 bucket with Object Lock turned on, and printed out the URLs and ARNs they needed for the next steps.

2. **Generate an API write key for their tenant.** Use a password generator to produce a random 32-character string. Open AWS Secrets Manager. Add an entry mapping that key to their tenant short-name. Save. The Lambdas pick up the new key within seconds without needing redeployment.

3. **Install the SDK.** `pip install ai-audit-ledger` for Python, or import the Node SDK from the repo.

4. **Set two environment variables.** `AUDIT_INGEST_URL` (from the CloudFormation output) and `AUDIT_WRITE_KEY` (the one they just generated).

5. **Call the SDK from their application.** Something like:
   ```python
   from ai_audit_ledger import AiAuditLedgerClient
   client = AiAuditLedgerClient(
       ingest_url=os.environ["AUDIT_INGEST_URL"],
       tenant_api_key=os.environ["AUDIT_WRITE_KEY"],
   )
   await client.log_decision_async(
       raw_system_prompt="You are a loan triage assistant...",
       raw_user_input="<applicant data>",
       model_version="claude-sonnet-4.7",
       ai_decision_output={"decision": "approved", "score": 0.87},
       human_in_loop=False,
   )
   ```
   The SDK hashes the PII locally, sends the digest plus the decision over the wire, and the call returns in around 80 milliseconds.

That was it. They could then go to the dashboard to see the record arrived and run a tamper check on it.

---

## 4. Version 0.2: the MCP server arrives

Shipped in May 2026. This was the moment the project pivoted from "library you call from code" to "tool the AI itself calls." Two flavours got built and released through the 0.2.x series, culminating in 0.2.1.

### What was new

- A standalone Model Context Protocol server, published to npm as `audit-ledger-mcp`
- Three tools the agent can call: `record_decision`, `verify_decision`, `list_decisions`
- A **zero-config sandbox mode**, so anyone could try it without setting up AWS first. Running `npx -y audit-ledger-mcp` with no environment variables just worked, writing to a shared public tenant on a hosted instance
- Listed in Anthropic's official MCP Registry under `io.github.shahidh68/audit-ledger-mcp` (this came with 0.2.1)
- The dashboard now supported a demo-mode link anyone could click

### What was still the same as 0.1

- The SDK path was unchanged. Existing customers using the SDK noticed nothing.
- PII hashing still used plain SHA-256.
- The ledger still only verified tampering, not completeness.

### What the customer had to do (MCP path)

If the customer was new and wanted to try it before committing:

1. **Run it with no setup.** `npx -y audit-ledger-mcp`. That was the whole step. The MCP server boots into sandbox mode, prints a banner on stderr explaining what is going on, and starts listening for the agent to call its tools.

2. **Wire it into their agent client.** For Claude Desktop this meant adding a JSON block to their config file:
   ```json
   {
     "mcpServers": {
       "audit-ledger-sandbox": {
         "command": "npx",
         "args": ["-y", "audit-ledger-mcp"]
       }
     }
   }
   ```
   Restart Claude Desktop and the three tools showed up in the menu.

For a customer ready to use it on real workloads (production mode), the steps were:

1. **Deploy the AWS stack** the same way 0.1 customers did.

2. **Generate both a write key and a read key** in Secrets Manager.

3. **Add the same JSON block to their agent client** but with the `env` section pointing at their own deployment:
   ```json
   {
     "mcpServers": {
       "audit-ledger": {
         "command": "npx",
         "args": ["-y", "audit-ledger-mcp"],
         "env": {
           "AUDIT_API_URL": "<their deployed API URL>",
           "AUDIT_WRITE_KEY": "<their write key>",
           "AUDIT_READ_KEY": "<their read key>"
         }
       }
     }
   }
   ```

That was it. Their agent could now record decisions, verify any individual record, and list recent decisions.

### What 0.2 still could not do

- The PII hashing was still reversible if anyone knew it was a low-entropy value like an email address. The hash leaving the customer's system was technically still personal data under ICO and EDPB guidance.
- If a record was deleted from the queryable database, no one could tell from outside, because there was no sequence to spot a gap in.

These two limitations are what 0.3 fixed.

---

## 5. Version 0.3: keyed hashing and completeness verification

Shipped today (June 2026). This was the response to a technical review that pointed out the two limitations of 0.2. Both got addressed without breaking any existing integration.

### What was new

**Keyed PII hashing (HMAC-SHA256).** The SDK and the MCP server now hash PII using HMAC-SHA256 with a secret the customer holds, instead of plain SHA-256 which anyone could potentially reverse. The customer generates the secret once, stores it alongside their other secrets, and never shares it with us. Existing setups keep working because if the secret is not set, the system falls back to plain SHA-256 and emits a one-time warning. Nothing breaks for anyone running 0.2.

**Per-tenant sequence numbers.** Every successfully stored decision now gets a number. Tenant Acme's decisions go 1, 2, 3, 4 in the order they were processed. A new endpoint, `verify_completeness`, returns any numbers that are missing from the sequence. A deleted record shows up as a gap. The honest answer to "can you prove the log is complete?" went from "we can't" to "yes, here is the missing list."

**Four MCP tools instead of three.** The new tool is `verify_completeness`. The other three are unchanged.

**One new DynamoDB table.** `TenantSequenceTable` holds the counter for each tenant. Only the processor Lambda writes to it. The read Lambda reads it to answer completeness questions.

### What the customer has to do (the new bits)

For the SDK path:

1. **Generate an HMAC secret on their own machine.** A single command produces a 64-character hex string:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Or the Python equivalent. They run this themselves. We never generate it for them and never see it.

2. **Store it in their environment as `AUDIT_HMAC_KEY`.** Same place they already keep `AUDIT_WRITE_KEY`: an env var, a `.env` file, AWS Secrets Manager, HashiCorp Vault, whatever they already use.

3. **Nothing else.** The SDK reads the variable automatically. The next call to `log_decision` uses HMAC instead of plain SHA-256.

For the MCP path:

1. **Generate the same HMAC secret** the same way as above.

2. **Add it to their agent client's MCP config.** For Claude Desktop:
   ```json
   "env": {
     "AUDIT_API_URL": "<their API URL>",
     "AUDIT_WRITE_KEY": "<their write key>",
     "AUDIT_READ_KEY": "<their read key>",
     "AUDIT_HMAC_KEY": "<their HMAC secret>"
   }
   ```
   Same shape for Cursor, same shape for LangGraph.

3. **Restart the client.** The MCP server picks up the new variable when the agent re-spawns it. The agent's next call to `record_decision` uses HMAC.

### Why the customer holds the key, not us

This is the bit that matters for a regulator. If we held the key, we could reverse the hash, and the hash would still legally count as personal data under ICO and EDPB guidance. Because the customer holds the key and we cannot reverse the hash, the value leaving their system is genuinely pseudonymised, not just fingerprinted. That distinction is what makes the GDPR data-minimisation claim defensible to a compliance team that reads the small print.

### What the customer should know about rotation

If they ever change the HMAC secret, all hashes computed after the rotation will be different from hashes computed before it, even for the same underlying value. For tamper verification this does not matter, because the ledger compares stored digests against stored digests and never needs to reverse them. For searching across the rotation boundary using the same PII value, the customer needs to keep the old key around. There is no scheme inside the ledger that re-keys old hashes, by design, because doing so would require us to know either the old or new key, which would defeat the entire point.

---

## 6. Architecture flow, end to end, including failures

Here is what happens, in order, from the moment the customer's AI makes a decision to the moment the record is locked in for seven years. Both the SDK path and the MCP path end up doing the same things in the cloud; only the first step is different.

### Step by step (SDK path)

1. **The customer's application makes an AI decision.** Their code has just received an output from a language model. Something like "approved, score 0.87, reasons: [...]".

2. **The application calls the SDK.** A line like `await client.log_decision_async(...)`. The SDK takes the raw prompt and raw user input as arguments, plus the structured decision output.

3. **The SDK hashes the PII locally.** Inside the customer's process, never going over the network, the SDK takes the raw user input, computes HMAC-SHA256 with the customer's `AUDIT_HMAC_KEY`, and produces a 64-character hex string. It does the same for the prompt. The raw values stay in memory; only the hashes will travel.

4. **The SDK sends a JSON payload to the API Gateway.** It POSTs to `/audit/events` with the customer's API write key in the `x-api-key` header. The payload contains: event ID, timestamp, model version, the two hashes, the structured decision output (which is allowed to be sent in clear), and a boolean for whether a human was in the loop.

### Step by step (MCP path)

1. **The agent decides to call the audit ledger.** The agent is using Claude Desktop or Cursor or LangGraph. It sees that `record_decision` is one of the tools available to it. It chooses to call it because the user or the workflow asked it to log this decision.

2. **The agent passes raw values to the MCP server over stdio.** The MCP server is running as a child process on the same machine as the agent. The agent does not need to know about hashing; it just passes the raw prompt, raw input, model version, decision output, and HITL flag.

3. **The MCP server hashes the PII locally.** Same as the SDK does. Same HMAC-SHA256 with `AUDIT_HMAC_KEY` from the MCP server's environment.

4. **The MCP server POSTs to the same API Gateway endpoint** the SDK would. Same `x-api-key` header, same JSON shape. From the AWS infrastructure's point of view, the two paths look identical from this point on.

### What happens in AWS (both paths)

5. **API Gateway hands the request to the Ingest Lambda.** This Lambda's job is to validate, not to store.

6. **The Ingest Lambda checks the API key against Secrets Manager.** It looks up the presented key in the tenant key map. If the key is unknown, it returns 401 Unauthorised. If the key is known, it resolves to a tenant ID and continues.

7. **The Ingest Lambda checks the per-tenant rate limit.** It does an atomic increment on a tiny DynamoDB table that tracks how many requests this tenant has sent in the current minute. If they have exceeded their quota, it returns 429 Too Many Requests.

8. **The Ingest Lambda validates the payload.** Schema check on every field. UUID format on the event ID. ISO 8601 format on the timestamp. 64-character hex format on the two hashes. Strict boolean on the HITL flag. If anything is wrong, 400 Bad Request.

9. **The Ingest Lambda puts the message on an SQS queue.** It returns 202 Accepted to the caller. The whole round trip takes around 80 milliseconds for the customer's code. The customer's application is now free to continue. The actual storage happens asynchronously from this point.

10. **SQS delivers the message to the Processor Lambda.** This is the worker that does the actual writing.

11. **The Processor Lambda does an idempotency check first.** It queries the audit table for any existing row with this event ID. If one exists and already has a sequence number, it skips everything else and returns successfully. This handles the case where SQS redelivered a message we already processed.

12. **The Processor Lambda allocates a sequence number.** It does an atomic increment on the `TenantSequenceTable` and gets back the next per-tenant number. If this is the first ever record for the tenant, the number is 1. If this is the thousandth, the number is 1000.

13. **The Processor Lambda writes to DynamoDB.** A row keyed by tenant ID plus a sort key built from the timestamp and event ID. The row contains everything in the original payload plus the freshly-assigned sequence number. The write has a conditional check that says "only write if no row exists with this sort key", so a true race condition during SQS redelivery cannot overwrite an existing record.

14. **The Processor Lambda writes to S3 with Object Lock.** A second copy of the same data, this time as a JSON file in a tenant-scoped folder in S3. The Object Lock policy is set to COMPLIANCE mode with a retention date seven years in the future. From this moment, no one, including the AWS account root user, can delete or alter that file until the retention date passes.

15. **The customer can now read the record back.** Either through the dashboard, the SDK's read helpers, the MCP server's `list_decisions` tool, or a direct curl. Verification of any single record uses `verify_decision` which fetches both the DynamoDB copy and the S3 copy and compares them. Verification that nothing is missing uses `verify_completeness` which compares the per-tenant counter against the actual rows present.

---

## 7. When things go wrong: the DLQ, the alerts, the recovery

The system is built to never lose a record even if individual components fail. Here is how each failure mode is handled.

### Failure: the customer's network or our API is briefly unreachable

The SDK and the MCP server both retry. Three attempts by default, with exponential backoff and jitter. If all three fail, the SDK raises an error the customer's code can catch. The MCP server returns an error to the agent which then decides what to do.

This protects against transient cloud issues but does not protect against the customer's code crashing entirely between making the AI decision and calling our SDK. That is a known limitation and the only way around it is for the customer to log the decision before acting on it, not after.

### Failure: the Ingest Lambda is throttled or has an error

The customer gets a 5xx response. The SDK retries. If retries are exhausted, the call fails. This is rare; the Ingest Lambda is reserved-concurrency-protected, so it cannot be starved by other Lambdas in the account.

### Failure: the Processor Lambda crashes or hits a timeout

This is the interesting one. The message has already been accepted (the customer got their 202). Now the Processor Lambda is supposed to write it to DynamoDB and S3, but something goes wrong: a DynamoDB throttle, an S3 service error, a code bug, a timeout because the Lambda was unusually slow.

SQS handles this with retries. The message is given five chances. Each time the Processor Lambda fails on it, SQS makes it visible to another invocation a couple of minutes later. The Lambda gets up to five attempts to succeed.

If, after five attempts, the message still cannot be processed, SQS gives up trying. Instead of throwing the message away, SQS moves it to a **Dead Letter Queue** (DLQ). This is a separate SQS queue that holds messages that could not be processed. Nothing is lost; the message just sits in the DLQ waiting for an operator to look at it.

### What happens when a message lands in the DLQ

1. **A CloudWatch alarm fires.** The alarm is configured to trigger if the DLQ has one or more messages visible. As soon as something lands there, the alarm is in the alarm state.

2. **An SNS topic is notified.** The alarm publishes to an SNS topic. The operator has subscribed an email address to that topic during deployment.

3. **The DLQ Consumer Lambda also fires.** This is a separate Lambda that triggers on any message arriving in the DLQ. Its only job is to extract details from the message (event ID, tenant ID, payload preview, retry count, timestamps) and publish a structured alert to the same SNS topic. The operator gets an email with the specifics, not just "something landed in the DLQ."

4. **The customer's tenant gets notified too.** The DLQ Consumer Lambda looks up the tenant's notification contact in `TenantContactsTable`. If the tenant has registered an email or webhook for failure notifications, the Lambda sends it. The customer knows their record failed to store within minutes, not days.

5. **The operator investigates.** The CloudWatch logs for the Processor Lambda will show why it failed. Sometimes it is a transient downstream issue that has since resolved; in that case, the operator manually replays the message from the DLQ back into the main queue. Sometimes it is a real bug; in that case, the bug gets fixed, deployed, and then the message is replayed.

Nothing is lost because nothing is deleted until the operator decides what to do.

### Failure: someone tries to tamper with a stored record

S3 Object Lock in COMPLIANCE mode means they cannot. Not the customer, not the operator, not the AWS account root user, not AWS itself. The S3 copy is genuinely untouchable until the retention date.

If someone tampers with the DynamoDB copy (which is the only writable copy), the `verify_decision` endpoint will detect it. The endpoint fetches both copies independently and compares them with stable JSON serialisation. Any difference flips `integrity_verified` to false and adds a warning note to the response.

Detection of tampering is loud. The dashboard surfaces it, the SDK returns it, the MCP server's `verify_decision` tool reports it, and there is a separate SNS mismatch topic that fires alarms if the nightly reconciler finds anything inconsistent between the two stores.

### Failure: a record disappears from DynamoDB

This is what 0.3's completeness verification covers. The per-tenant sequence numbers mean a deleted row leaves a gap in the sequence. The `verify_completeness` endpoint returns the gap as a missing number.

To distinguish between "the record was deleted" and "the record was never written due to a true SQS redelivery race", the Processor Lambda logs a structured `sequence_burned` event whenever it allocates a number but cannot complete the write. An operator looking at a gap can grep the processor logs for the burned-sequence entries and see whether the gap is benign (a burn) or real (a deletion). Section 14 of the runbook walks through that procedure.

### Failure: Secrets Manager itself is unreachable

This is rare but worth covering. The Lambdas cache the key map in memory and only refresh on cache miss. If Secrets Manager is unreachable when the cache needs refreshing, the Lambda surfaces a 500 and the customer's SDK retries. If it remains unreachable, ingestion stops. This is fail-secure: better to refuse writes than to accept writes we cannot authenticate.

---

## 8. Cheat sheet: what the customer has to do, by version and path

### SDK path

| Version | One-time setup | Per-call code |
|---|---|---|
| 0.1 | Install SDK, generate write key, set `AUDIT_INGEST_URL` and `AUDIT_WRITE_KEY` | `client.log_decision_async(raw_prompt=..., raw_input=..., decision=..., ...)` |
| 0.2 | Same as 0.1 | Same as 0.1 |
| 0.3 | Same as 0.1 plus generate `AUDIT_HMAC_KEY` and add to environment | Same as 0.1; SDK now uses HMAC under the hood |

### MCP path (production mode)

| Version | One-time setup | Per-call (handled by agent automatically) |
|---|---|---|
| 0.1 | Not available | n/a |
| 0.2 | Install via `npx`, deploy AWS stack, generate write + read keys, add `env` block to agent client config (`AUDIT_API_URL`, `AUDIT_WRITE_KEY`, `AUDIT_READ_KEY`) | Agent calls `record_decision`, `verify_decision`, or `list_decisions` |
| 0.3 | Same as 0.2 plus generate `AUDIT_HMAC_KEY` and add it to the `env` block | Agent now also has `verify_completeness` tool available |

### MCP path (sandbox mode)

| Version | One-time setup | Per-call |
|---|---|---|
| 0.1 | Not available | n/a |
| 0.2 | Just `npx -y audit-ledger-mcp`. No AWS account, no keys. Records go to the shared public tenant. | Agent calls the three tools as usual |
| 0.3 | Same as 0.2 | Agent now has four tools |

### Operational checks the operator runs after deploy (any version)

| Check | How |
|---|---|
| Stack deployed | `aws cloudformation describe-stacks --stack-name AiAuditLedgerStack` |
| API healthy | `curl https://<api-url>/audit/logs` returns 401 (correct: no key sent) |
| Tenant key works | `curl -H "x-api-key: <key>" https://<api-url>/audit/events -d '...'` returns 202 |
| Record landed | Wait 2 seconds, check dashboard or `list_decisions` |
| Tamper-evidence works | Click a record in the dashboard, look for the green tick |
| (0.3 only) Sequence allocated | The record in the dashboard now shows a `sequence_no` field |
| (0.3 only) Completeness works | Call `verify_completeness`, expect zero missing |
| DLQ is empty | `aws sqs get-queue-attributes --queue-url <DLQ url> --attribute-names ApproximateNumberOfMessages` returns 0 |

If any of those fail, sections 8 (Email alerts) and 9 (Troubleshooting) of the runbook walk through the diagnostic steps.

---

## Closing thought

The two paths (SDK and MCP) and the three versions (0.1, 0.2, 0.3) all converge on the same AWS infrastructure and the same regulatory claim. What changed across versions was not the storage layer, which has been tamper-evident from day one, but the customer's surface area: 0.1 gave them code, 0.2 gave them a tool any agent could call, and 0.3 made the privacy claim defensible and the completeness claim provable. The architecture diagram you would draw for a regulator is unchanged across all three versions. The thing you can tell the regulator with a straight face is meaningfully stronger in 0.3 than it was in 0.2.
