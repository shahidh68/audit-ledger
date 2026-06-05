# AI Audit Ledger: Customer Handover Pack

What to give the customer when they take over operation of their own deployed audit ledger. This is the checklist Zyvra hands over at the end of a Phase 3 engagement, or that a customer's internal team uses when adopting the open-source repos and standing up their own deployment.

Read this alongside `RUNBOOK.md` (day-to-day operations), `ARCHITECTURE.md` (technical reference), and `DEPLOYMENT.md` (first-deploy walkthrough). This document is the inventory of what must change hands, not the procedures themselves.

---

## Contents

1. [Who this is for](#1-who-this-is-for)
2. [AWS deployment outputs to record](#2-aws-deployment-outputs-to-record)
3. [Secrets to populate before going live](#3-secrets-to-populate-before-going-live)
4. [Information their developers need (SDK path)](#4-information-their-developers-need-sdk-path)
5. [Information their developers need (MCP path)](#5-information-their-developers-need-mcp-path)
6. [What the customer holds and must never share](#6-what-the-customer-holds-and-must-never-share)
7. [Monitoring channels and who watches them](#7-monitoring-channels-and-who-watches-them)
8. [The HMAC key conversation (mandatory)](#8-the-hmac-key-conversation-mandatory)
9. [Per-tenant onboarding (if they operate multi-tenant)](#9-per-tenant-onboarding-if-they-operate-multi-tenant)
10. [Cost expectations](#10-cost-expectations)
11. [Compliance disclaimers (mandatory)](#11-compliance-disclaimers-mandatory)
12. [Support and escalation](#12-support-and-escalation)
13. [Handover sign-off checklist](#13-handover-sign-off-checklist)

---

## 1. Who this is for

This document is for the **operator** of the audit ledger: the role that runs the AWS stack, manages secrets, adds customers, watches alarms, and is the on-call rotation when something fails. In most engagements, this is the customer's platform team or their security engineering function.

If the customer is using the audit ledger as a **consumer** (their AI application calls the SDK, or their agent calls the MCP server, and someone else operates the ledger for them), they only need sections 4, 5, 6, and 8. The rest is operator scope.

---

## 2. AWS deployment outputs to record

After `cdk deploy` finishes, CloudFormation prints a set of stack outputs. Record every one of these and store them somewhere their team can find them later. Their secrets manager, their wiki, their password manager. Whichever is the canonical location for "things our platform team needs to know."

| Output | What it is | Where their team uses it |
|---|---|---|
| `ApiBaseUrl` | The HTTPS URL of their API Gateway | Configuring SDKs and MCP servers, dashboard access |
| `IngestUrl` | Base URL plus `/audit/events` | The endpoint the SDK posts to |
| `ReadUrl` | Base URL plus `/audit/logs` | The endpoint the dashboard reads from |
| `AuditTableName` | DynamoDB table name for audit records | Direct queries during investigations |
| `TenantSequenceTableName` | DynamoDB table name for the per-tenant counter (v0.3+) | Inspecting allocation state, completeness debugging |
| `AuditBucketName` | S3 bucket with Object Lock | Direct S3 access during forensic work |
| `QueueUrl` | Main SQS queue URL | Manual message inspection in rare cases |
| `DlqUrl` | Dead-letter queue URL | Message replay after a failure has been fixed |
| `DlqAlarmName` | CloudWatch alarm name for DLQ messages | Confirming the alarm is in the right state |
| `DlqAlertTopicArn` | SNS topic for DLQ alerts | Adding or removing alert subscribers |
| `MismatchTopicArn` | SNS topic for tamper-mismatch alerts | Adding or removing alert subscribers |
| `TenantKeySecretArn` | Secrets Manager ARN for ingest key map | All write-key management |
| `ReadKeySecretArn` | Secrets Manager ARN for read key map | All read-key and dashboard-access management |
| `TenantContactsTableName` | DynamoDB table for per-tenant notification config | Adding email or webhook contacts for tenants |
| `DashboardUrl` | Hosted dashboard URL | What their compliance team and customers connect to |

Make sure the operator can read these at any time. Either pin them to a wiki page that links to `aws cloudformation describe-stacks --stack-name AiAuditLedgerStack --query "Stacks[0].Outputs"`, or copy them into a shared location.

---

## 3. Secrets to populate before going live

The CDK stack deploys with placeholder values in Secrets Manager (intentionally, so a redeploy never overwrites real keys). The operator must populate the real values before the system accepts any production traffic.

**TenantKeyMapSecret** (ARN in stack outputs)

Populate with the actual write keys mapped to tenant IDs. JSON shape:

```json
{
  "wk-prod-tenant-a-XaBc123...": "tenant-a",
  "wk-prod-tenant-b-YzDe456...": "tenant-b"
}
```

If the customer is running a single-tenant deployment for their own internal use, populate with just their one key.

**ReadKeyMapSecret** (ARN in stack outputs)

Populate with read keys. JSON shape:

```json
{
  "rk-admin-internal-Aa111...": "*",
  "rk-tenant-a-Bb222...": "tenant-a"
}
```

The `*` value means admin access (can read across all tenants). Any other value scopes the key to that specific tenant.

**Smoke test every read key after populating.** This is the most important step because the read Lambda caches the secret map. A typo in the JSON value (mapping a key to the wrong tenant name) will silently return empty results rather than failing loudly. Hit each key against the read endpoint and confirm it returns expected records.

```
curl -H "x-api-key: <each-read-key>" "<ApiBaseUrl>/audit/logs"
```

The response should show `tenant_id` matching what the operator expects, and a non-empty `items` array if records exist for that tenant. If `tenant_id` shows the wrong value, fix the JSON before going live.

---

## 4. Information their developers need (SDK path)

If their internal team is integrating the SDK into a Python or Node application, they need:

| Item | Where it comes from |
|---|---|
| `AUDIT_INGEST_URL` (Python) or `AUDIT_API_URL` (Node) | `IngestUrl` (Python) or `ApiBaseUrl` (Node) stack output |
| `AUDIT_WRITE_KEY` | The tenant write key from `TenantKeyMapSecret` for their tenant |
| `AUDIT_HMAC_KEY` (v0.3+) | They generate this themselves. See section 8. |
| The SDK | `pip install ai-audit-ledger` or import the Node SDK from the repo |
| A sample integration | The `apps/resume-screener` directory in the repo has a working example |

Send these in a secure channel. Not plain email if avoidable. The operator does not generate or hold the customer's HMAC key.

---

## 5. Information their developers need (MCP path)

If their team is wiring the audit ledger into an AI agent (Claude Desktop, Cursor, LangGraph, custom), they need:

| Item | Where it comes from |
|---|---|
| `AUDIT_API_URL` | `ApiBaseUrl` stack output |
| `AUDIT_WRITE_KEY` | The tenant write key from `TenantKeyMapSecret` |
| `AUDIT_READ_KEY` | The tenant read key from `ReadKeyMapSecret` |
| `AUDIT_HMAC_KEY` (v0.3+) | They generate this themselves. See section 8. |
| Installation command | `npx -y audit-ledger-mcp` |
| Sample client configuration | The `audit-ledger-mcp` README has working examples for each supported client |

If they are using the public sandbox to evaluate, they need none of the above. The sandbox is zero-config: `npx -y audit-ledger-mcp` with no environment variables connects to the shared public tenant.

---

## 6. What the customer holds and must never share

The whole regulatory characterisation of the system depends on a small number of values being held only on the customer's side. The operator must make this list explicit to the receiving team.

| Item | Who generates | Who holds | What happens if leaked |
|---|---|---|---|
| `AUDIT_HMAC_KEY` (the tenant's HMAC secret) | Customer generates locally | Customer only. The operator never sees it. | All PII hashes computed with this key become reversible by anyone who obtains the key. Treat as a serious incident. Rotate immediately. Hashes computed before rotation remain valid for integrity verification but lose pseudonymisation strength. |
| `AUDIT_WRITE_KEY` (the tenant's API write key) | Operator generates and stores in Secrets Manager | Both the operator and the customer | A leaked write key lets someone write fake decisions into the customer's tenant. Doesn't let them read existing data. Operator rotates via runbook section 3. |
| `AUDIT_READ_KEY` (the tenant's API read key) | Operator generates and stores in Secrets Manager | Both the operator and the customer | A leaked read key lets someone read the customer's records. Doesn't let them write or delete anything. Operator rotates via runbook section 3. |
| Admin read key (`"*"` tenant) | Operator generates and stores in Secrets Manager | Operator only | Reads ALL tenants. Treat as the most sensitive credential. Rotate at the first sign of compromise. |

Make this table explicit in writing during the handover. The HMAC key in particular is unusual in that the customer is responsible for it and the operator must not be able to recover it. That responsibility shift surprises operations teams that have been trained to be the source of truth for all credentials.

---

## 7. Monitoring channels and who watches them

The system has two distinct failure-notification paths because there are two distinct audiences: the operator on-call who runs the platform, and the tenant whose specific record failed. The customer's operations team needs to understand both and configure both.

### Operator alerts (deploy-time SNS subscription)

This is the platform on-call's channel. Set up at deploy time and edited only via the AWS Console afterwards.

| Channel | What lands here | What it means | Audience |
|---|---|---|---|
| `DlqAlertTopic` (SNS) | A message failed all five processor retries and landed in the DLQ | A specific audit record failed to store somewhere in the pipeline | Platform on-call |
| `MismatchTopic` (SNS) | The nightly reconciler found a record where DynamoDB and S3 disagree | Possible tampering or operational error. Treat as urgent. | Platform on-call, security team, possibly legal |
| `DlqAlarm` (CloudWatch) | DLQ has one or more visible messages | Same condition as `DlqAlertTopic`, surfaced as an alarm state for dashboards | Platform on-call dashboards |

**How the initial subscription gets set:** Pass `--context alertEmail=ops@customer.com` at first `cdk deploy`. The stack subscribes that address to `DlqAlertTopic` and `MismatchTopic` automatically, and wires `DlqAlarm` to publish to `DlqAlertTopic`.

**How to add more subscribers after deploy:** AWS Console > SNS > select topic > Create subscription. Choose Email or HTTPS (for PagerDuty, Slack webhook, OpsGenie, etc.). For email, the subscriber receives a confirmation message and must click the link before they actually start receiving alerts.

### Per-tenant notifications (runtime, managed in the dashboard)

This is how a specific tenant gets notified when one of *their* records fails. Different channel, different audience, different management path.

| Channel | Where managed | What lands here |
|---|---|---|
| Tenant email contact | Dashboard > "Tenant Contacts" page (or `PUT /admin/tenants/{tenantId}/contact`) | DLQ Consumer Lambda emails the tenant via SES when one of their records lands in the DLQ. Reconciler Lambda emails them on a tamper mismatch involving their records. |
| Tenant webhook contact | Same page | Same conditions as above, delivered via HTTP POST instead of email |

**How to set it up:** Log into the dashboard with the admin read key. Open the **Tenant Contacts** page. Click **+ Add tenant**. Enter the tenant ID, the email address (and/or webhook URL), save. The change takes effect immediately. No redeploy. No SNS subscription needed.

**Why this is different from operator alerts:** A tenant should not be subscribed to the SNS topic directly, because they would see every other tenant's failures too. The DLQ Consumer Lambda fans out the per-tenant notification by reading `TenantContactsTable` and sending a tailored email or webhook to only the affected tenant.

**Prerequisite:** SES sender domain must be verified. This is set at deploy time via `--context sesSenderEmail=noreply@customer.com`. Without a verified SES sender, the per-tenant email notifications will fail silently. The operator alerts via SNS subscription will still work.

### Net effect when a record fails

Concrete walk-through of what happens when tenant X's record lands in the DLQ:

1. CloudWatch alarm fires because the DLQ has a message
2. Alarm publishes to `DlqAlertTopic` → operator on-call email (and any other SNS subscribers) receive the alarm
3. DLQ Consumer Lambda is triggered by the DLQ message
4. DLQ Consumer publishes a structured detail message back to `DlqAlertTopic` → operator on-call gets a second email with event ID, retry count, payload preview, diagnosis hint
5. DLQ Consumer reads `TenantContactsTable`, finds tenant X's email and/or webhook, sends them a tailored notification via SES (or HTTPS)

The operator sees both flavours (alarm + detail). Tenant X sees only their own. Other tenants see nothing.

The runbook (section 8) walks through what each email looks like in practice.

---

## 8. The HMAC key conversation (mandatory)

This is the conversation the operator has with the customer's developer team during onboarding. If this conversation does not happen, the customer ends up in the back-compat fallback path (plain SHA-256) without realising it.

**What to tell them:**

> "Generate a 32-byte secret on your own machine using `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"` or `python -c \"import secrets; print(secrets.token_hex(32))\"`. Store the result in your environment as `AUDIT_HMAC_KEY` wherever you already keep `AUDIT_WRITE_KEY`. We never see it. We never generate it for you. We never store a backup. That is the entire point of the design: a regulator asking 'who could reverse these PII hashes?' gets the answer 'only the customer.' If we held the key, the hashes would still be personal data under ICO and EDPB guidance."

**What to make explicit:**

- They generate it. The operator does not.
- They store it. The operator does not back it up.
- They rotate it. The operator does not.
- If they lose it without a backup, hashes computed under the lost key remain valid for integrity verification but cannot be reversed by anyone, including them. PII lookups across the rotation boundary stop working. They generate a new key and accept the limitation.
- If they refuse to set one, the SDK and MCP fall back to plain SHA-256 with a deprecation warning. Their integration keeps working. Their digests are weaker than they should be. Their problem to own, not the operator's.

Get explicit acknowledgement that they understand this. The operator's hands are deliberately tied here, and customer teams that have been onboarded to other systems often expect the operator to be the source of truth for all credentials. This one is different.

---

## 9. Per-tenant onboarding (if they operate multi-tenant)

If the customer is hosting the audit ledger on behalf of multiple downstream tenants (rather than running it for their own internal use), the operator needs a documented onboarding flow. Section 1 of the runbook walks through it. The condensed version:

1. Generate a 32-character random write key for the new tenant (any password generator works)
2. Add it to `TenantKeyMapSecret` in Secrets Manager as a JSON entry mapping key to tenant short-name
3. Optionally generate a read key for them (if they want to query their own records) and add to `ReadKeyMapSecret`
4. Optionally register their notification contact in `TenantContactsTable` so they get alerted when their messages fail
5. Send them the four things their developers need (sections 4 or 5 above), plus the HMAC key conversation (section 8)

Tenant offboarding is the reverse: remove from both secrets, leave their records in place (S3 Object Lock means the operator cannot delete them anyway, and DynamoDB records are kept for audit history).

---

## 10. Cost expectations

The system runs on AWS pay-as-you-go services with no upfront commitment. For a customer with low-to-moderate audit volume (tens of thousands of decisions per month), the expected monthly cost is in the range of fifteen to fifty US dollars. This is dominated by:

| Service | Why it costs money | Typical share |
|---|---|---|
| API Gateway | Per request invocation | ~30% |
| Lambda | Invocations and duration | ~25% |
| DynamoDB | On-demand reads and writes | ~20% |
| S3 (audit bucket) | Storage and PUT requests | ~15% |
| SQS, CloudWatch, SNS, Secrets Manager | All other | ~10% |

For a customer with high volume (millions of decisions per month), the cost scales roughly linearly. The S3 storage cost grows over time because Object Lock prevents deletion before the retention date, so the bucket grows monotonically until year seven. Plan for that growth in the cost model.

If the customer wants to reduce cost on high volume, the levers are:

- Move DynamoDB to provisioned capacity once the load profile is stable
- Increase Lambda batch size on the processor (currently 10)
- Set S3 lifecycle rules to transition older objects to Glacier (still Object Lock protected)

None of these are needed at low or moderate volume.

---

## 11. Compliance disclaimers (mandatory)

The operator must make these explicit in writing as part of the handover. The customer's legal team should see them before the system processes its first production record.

**This is technical infrastructure.** The audit ledger captures and stores evidence of AI decisions in a regulator-defensible way. Whether that evidence satisfies any specific obligation under the EU AI Act, FCA SS1/23, GDPR, or any other framework is a question for the customer's legal counsel reviewing their specific obligations. The architecture is built with those frameworks in mind; certifying compliance is not Zyvra's responsibility and not what the open-source project provides.

**Pseudonymisation is not anonymisation.** The HMAC hashing makes the digest non-reversible by parties who do not hold the customer's key. Under GDPR, that is pseudonymisation and the digest is still personal data when the customer themselves processes it. The operator's claim is that the data is not personal data on the operator's side of the wire, not that it stops being personal data in absolute terms.

**The retention period is set in the deployment.** Default is seven years. If a customer's regulatory obligation requires a different period, that must be configured at deploy time using the `retentionYears` CDK context parameter. Changing it after deployment requires a stack replacement and is not a routine operation.

**Tamper-evidence is technical, not behavioural.** S3 Object Lock prevents alteration of stored records. It does not prevent someone from never writing the record in the first place. The completeness verification helps with the latter case from v0.3 forward, but the customer's application is still responsible for actually calling `record_decision` for every decision they want logged.

**The system does not assess the AI decisions.** It records what the AI did. Whether the AI's decisions were good, fair, accurate, or compliant is a separate concern that requires the customer's own model risk testing, bias auditing, and human review processes.

---

## 12. Support and escalation

Tell the customer who to contact for what.

| Situation | Who to contact |
|---|---|
| Bug in the open-source code | Open an issue at `github.com/shahidh68/audit-ledger` |
| Question about how something works | Refer to `RUNBOOK.md`, `ARCHITECTURE.md`, or the case study at `zyvra.studio/work/audit-ledger.html` |
| Suspected production incident on their deployment | Their internal on-call. The operator does not have access to their AWS account. |
| AWS service outage | `status.aws.amazon.com`. The audit ledger inherits whatever AWS uptime is. |
| Suspected data breach or tampering | Their legal team and security team. Preserve all evidence. Do not delete anything. |
| Engagement-specific question for Zyvra | Whatever channel was agreed at engagement start (typically a shared Slack channel or email alias) |

Make sure the customer understands the boundary: Zyvra builds and hands over the system. The customer operates it. Zyvra is not the on-call for their production incidents unless that has been explicitly agreed in writing as part of an ongoing support contract.

---

## 13. Handover sign-off checklist

Walk through this list with the customer at handover. Each item should be visibly ticked or explicitly acknowledged. Use this as the document that closes out the engagement.

- [ ] Customer can access all CloudFormation stack outputs (section 2)
- [ ] `TenantKeyMapSecret` populated with real values, not placeholder
- [ ] `ReadKeyMapSecret` populated with real values, not placeholder
- [ ] Every read key smoke-tested and confirmed to return the correct tenant
- [ ] Customer's developers have the env vars they need (section 4 or 5)
- [ ] The HMAC key conversation has happened (section 8) and the customer has acknowledged that they generate, hold, and rotate it themselves
- [ ] Alert subscriptions are set up on `DlqAlertTopic` and `MismatchTopic` to a channel the customer's on-call actually watches
- [ ] SES sender domain is verified and a test per-tenant notification has been successfully delivered to a real tenant inbox or webhook
- [ ] At least one tenant has been added via the dashboard's "Tenant Contacts" page to confirm the runtime contact management path works
- [ ] Customer has been pointed at `RUNBOOK.md` and confirmed they know where to find it
- [ ] Customer has been pointed at `ARCHITECTURE.md` and `VERSION-WALKTHROUGH.md` for deeper reference
- [ ] Customer's legal team has reviewed the compliance disclaimers (section 11)
- [ ] Cost expectations have been communicated (section 10) and a budget alarm has been configured in AWS Billing for an upper threshold the customer is comfortable with
- [ ] The customer has done at least one end-to-end test: write a record, see it in the dashboard, run `verify_decision`, run `verify_completeness` (v0.3+)
- [ ] Per-tenant onboarding flow has been demonstrated (if multi-tenant)
- [ ] Customer knows how to add another team member to the dashboard
- [ ] Customer knows how to rotate a write key in an emergency
- [ ] Customer knows how to replay messages from the DLQ if any land there
- [ ] Customer has the engagement-specific support channel for follow-up questions

Once every item is ticked, the customer is operating the system independently. Zyvra's involvement ends at that boundary unless a separate support contract is in place.
