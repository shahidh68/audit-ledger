/**
 * reconciler.mjs — Hourly reconciliation Lambda
 *
 * Triggered by EventBridge Scheduler every hour.
 * Queries DynamoDB for all records written since the last run,
 * fetches the corresponding S3 object for each, compares them,
 * and publishes an SNS alert for every mismatch found.
 *
 * State: the timestamp of the last successful run is stored in a
 * DynamoDB item (RECONCILER_STATE_TABLE, pk="lastRunAt") so the
 * window is always contiguous — no gaps, no double-checking.
 *
 * Environment variables (set by CDK):
 *   AUDIT_TABLE              — DynamoDB audit table name
 *   AUDIT_BUCKET             — S3 audit bucket name
 *   RECONCILER_STATE_TABLE   — DynamoDB state table name
 *   SNS_TOPIC_ARN            — SNS topic to publish alerts to
 *   RESTORE_APPROVAL_TABLE   — DynamoDB table for restore approval tokens
 *   API_BASE_URL             — API Gateway base URL for building restore links
 */

import {
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { randomUUID } from 'crypto';
import { notifyTenant } from './lib/tenantNotifier.js';

// ─── clients ──────────────────────────────────────────────────────────────────

const dynamo = new DynamoDBClient({});
const s3     = new S3Client({});
const sns    = new SNSClient({});

// ─── internal helpers ─────────────────────────────────────────────────────────

/**
 * Read the timestamp of the last successful reconciliation run.
 * Returns an ISO string, or null if this is the first run.
 */
async function getLastRunAt() {
  const res = await dynamo.send(new GetItemCommand({
    TableName: process.env.RECONCILER_STATE_TABLE,
    Key: marshall({ pk: 'lastRunAt' }),
  }));
  return res.Item ? unmarshall(res.Item).value : null;
}

/**
 * Persist the timestamp of the current run so the next invocation
 * knows where to start.
 */
async function setLastRunAt(isoTimestamp) {
  await dynamo.send(new PutItemCommand({
    TableName: process.env.RECONCILER_STATE_TABLE,
    Item: marshall({ pk: 'lastRunAt', value: isoTimestamp }),
  }));
}

/**
 * Fetch all audit records written between fromIso and toIso across
 * all tenants.  Uses a Scan with a filter expression — acceptable here
 * because reconciliation is a background job and not latency-sensitive.
 * All pages are followed automatically.
 */
async function fetchRecordsSince(fromIso, toIso) {
  const records = [];
  let lastKey   = undefined;

  do {
    const res = await dynamo.send(new ScanCommand({
      TableName:                 process.env.AUDIT_TABLE,
      FilterExpression:          '#ts BETWEEN :from AND :to',
      ExpressionAttributeNames:  { '#ts': 'timestamp' },
      ExpressionAttributeValues: marshall({ ':from': fromIso, ':to': toIso }),
      ExclusiveStartKey:         lastKey,
    }));
    records.push(...(res.Items ?? []).map(unmarshall));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return records;
}

/**
 * Fetch a single record from S3 and parse it as JSON.
 * Returns null if the object does not exist (missing is itself a mismatch).
 */
async function fetchS3Record(tenantId, eventId) {
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: process.env.AUDIT_BUCKET,
      Key:    `${tenantId}/${eventId}.json`,
    }));
    const body = await res.Body.transformToString();
    return JSON.parse(body);
  } catch (err) {
    if (err.name === 'NoSuchKey') return null;
    throw err;
  }
}

/**
 * Deterministic JSON serialisation: sorts keys before stringifying so
 * field insertion order never causes a false mismatch.
 * Matches the same approach used in the Read Lambda's history endpoint.
 */
function stableJson(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

/**
 * Compare a DynamoDB record against its S3 counterpart.
 * Returns null if they match, or a structured mismatch object if they differ.
 */
function compare(dynRecord, s3Record) {
  // Strip the DynamoDB-only sort key before comparing — it is never written to S3.
  const { sk, ...dynComparable } = dynRecord;

  if (s3Record === null) {
    return {
      event_id:  dynRecord.event_id,
      tenant_id: dynRecord.tenant_id,
      reason:    'S3 object missing',
    };
  }

  const dynJson = stableJson(dynComparable);
  const s3Json  = stableJson(s3Record);

  if (dynJson !== s3Json) {
    return {
      event_id:  dynRecord.event_id,
      tenant_id: dynRecord.tenant_id,
      reason:    'Content mismatch',
      dynRecord: dynComparable,
      s3Record,
    };
  }

  return null;
}

/**
 * Create a single-use restore approval token in DynamoDB and return its URL.
 * Returns null on failure so a token error never blocks the mismatch alert.
 *
 * @param {string} eventId
 * @param {string} tenantId
 * @returns {Promise<string|null>} Full restore URL, or null if creation failed.
 */
async function createRestoreLink(eventId, tenantId) {
  const approvalTable = process.env.RESTORE_APPROVAL_TABLE;
  const apiBaseUrl    = process.env.API_BASE_URL;
  if (!approvalTable || !apiBaseUrl) return null;

  try {
    const token    = randomUUID();
    const nowEpoch = Math.floor(Date.now() / 1000);

    await dynamo.send(new PutItemCommand({
      TableName: approvalTable,
      Item: marshall({
        token,
        event_id:     eventId,
        tenant_id:    tenantId,
        status:       'pending',
        requested_at: new Date().toISOString(),
        ttl:          nowEpoch + (48 * 60 * 60),
      }),
    }));

    return `${apiBaseUrl}audit/restore/${token}`;
  } catch (err) {
    console.error(`[reconciler] Failed to create restore token for event_id=${eventId}`, err);
    return null;
  }
}

/**
 * Publish a single SNS alert summarising all mismatches found in this run.
 * Each mismatch includes a one-click restore link where available.
 *
 * @param {Array<{event_id: string, tenant_id: string, reason: string, restoreUrl?: string|null}>} mismatches
 */
async function publishAlert(mismatches, windowFrom, windowTo) {
  const subject = `[AI Audit Ledger] ${mismatches.length} tamper mismatch(es) detected`;
  const message = [
    subject,
    `Window: ${windowFrom} → ${windowTo}`,
    `Total mismatches: ${mismatches.length}`,
    '',
    ...mismatches.map((m, i) => {
      const lines = [
        `[${i + 1}] event_id=${m.event_id}  tenant_id=${m.tenant_id}  reason=${m.reason}`,
      ];
      if (m.restoreUrl) {
        lines.push(`    Restore from archive: ${m.restoreUrl}`);
        lines.push('    (Link is valid for 48 hours and can only be used once.)');
      }
      return lines.join('\n');
    }),
    '',
    'Review each event via GET /audit/events/{eventId}/history for the full diff.',
  ].join('\n');

  await sns.send(new PublishCommand({
    TopicArn: process.env.SNS_TOPIC_ARN,
    Subject:  subject,
    Message:  message,
  }));
}

// ─── handler ──────────────────────────────────────────────────────────────────

export async function handler() {
  const runAt    = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const lastRunAt = await getLastRunAt();

  // On the very first run, look back 1 hour as a safe bootstrap window.
  const windowFrom = lastRunAt ?? new Date(Date.now() - 60 * 60 * 1000)
    .toISOString().replace(/\.\d{3}Z$/, 'Z');
  const windowTo   = runAt;

  console.log(`[reconciler] window: ${windowFrom} → ${windowTo}`);

  const records    = await fetchRecordsSince(windowFrom, windowTo);
  console.log(`[reconciler] ${records.length} record(s) to check`);

  const mismatches = [];

  for (const dynRecord of records) {
    const s3Record = await fetchS3Record(dynRecord.tenant_id, dynRecord.event_id);
    const mismatch = compare(dynRecord, s3Record);
    if (mismatch) {
      console.warn(`[reconciler] mismatch: ${JSON.stringify(mismatch)}`);
      mismatches.push(mismatch);
    }
  }

  if (mismatches.length > 0) {
    // Generate one-click restore links for each mismatch in parallel.
    // Failures are tolerated — a missing link never blocks the alert.
    const mismatchesWithLinks = await Promise.all(
      mismatches.map(async (m) => ({
        ...m,
        restoreUrl: await createRestoreLink(m.event_id, m.tenant_id),
      })),
    );

    await publishAlert(mismatchesWithLinks, windowFrom, windowTo);
    console.error(`[reconciler] ${mismatches.length} mismatch(es) — operator SNS alert sent`);

    // Notify each affected tenant individually.
    // Group mismatches by tenant so one tenant with multiple affected records
    // receives a single combined notification rather than one per record.
    const contactsTable = process.env.TENANT_CONTACTS_TABLE;
    const senderEmail   = process.env.SES_SENDER_EMAIL;

    if (contactsTable && senderEmail) {
      const byTenant = mismatchesWithLinks.reduce((acc, m) => {
        (acc[m.tenant_id] ??= []).push(m);
        return acc;
      }, {});

      await Promise.all(
        Object.entries(byTenant).map(([tenantId, items]) => {
          const count = items.length;
          return notifyTenant(contactsTable, senderEmail, {
            event_type:  'tamper_detected',
            event_id:    items[0].event_id,
            tenant_id:   tenantId,
            subject:     `[AI Audit Ledger] Integrity alert — ${count} audit record${count > 1 ? 's' : ''} need attention`,
            message: [
              'A discrepancy has been detected in your audit records.',
              'Our team has been notified and is investigating. No action is required from you.',
              '',
              `Affected record${count > 1 ? 's' : ''}:`,
              ...items.map((m) => `  event_id: ${m.event_id}  (${m.reason})`),
              '',
              'If a record needs to be restored from the verified archive, you will receive',
              'a separate confirmation once the restoration is complete.',
              '',
              'You can verify the integrity of any record using:',
              '  GET /audit/events/{eventId}/history',
            ].join('\n'),
            occurred_at: new Date().toISOString(),
          });
        }),
      );
    }
  } else {
    console.log(`[reconciler] all ${records.length} record(s) verified clean`);
  }

  // Only advance the watermark when the run completes without throwing,
  // so a partial failure re-checks the same window next time.
  await setLastRunAt(runAt);

  return {
    window:     { from: windowFrom, to: windowTo },
    checked:    records.length,
    mismatches: mismatches.length,
  };
}
