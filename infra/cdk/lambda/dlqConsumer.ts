/**
 * DLQ Consumer Lambda — reads messages that failed all 5 processor retries.
 *
 * For each failed message:
 *   - Logs structured details to CloudWatch (always)
 *   - Publishes a full technical alert to the operator SNS topic
 *   - Notifies the affected tenant via their configured email/webhook (if set)
 *
 * The original message is left in the DLQ so it can be inspected or replayed
 * manually once the root cause is resolved. SQS auto-deletes after 14 days.
 */
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { notifyTenant } from './lib/tenantNotifier';

const sns = new SNSClient({});

export async function handler(event: SQSEvent): Promise<void> {
  const topicArn = process.env.SNS_TOPIC_ARN;
  if (!topicArn) console.error('[dlq-consumer] SNS_TOPIC_ARN not set — logging only');

  for (const record of event.Records) {
    await processFailedRecord(record, topicArn);
  }
}

async function processFailedRecord(record: SQSRecord, topicArn?: string): Promise<void> {
  // ── Parse original payload ────────────────────────────────────────────────
  let payload: Record<string, unknown> = {};
  let parseError: string | null = null;

  try {
    payload = JSON.parse(record.body) as Record<string, unknown>;
  } catch {
    parseError = 'Message body is not valid JSON — payload may be corrupt';
  }

  const eventId  = String(payload.event_id   ?? '(unknown)');
  const tenantId = String(payload.tenant_id  ?? '(unknown)');
  const model    = String(payload.model_version ?? '(unknown)');
  const eventTs  = String(payload.timestamp  ?? '(unknown)');

  // ── SQS system attributes ─────────────────────────────────────────────────
  const retryCount    = record.attributes.ApproximateReceiveCount ?? '?';
  const sentAt        = record.attributes.SentTimestamp
    ? new Date(Number(record.attributes.SentTimestamp)).toISOString()
    : '(unknown)';
  const firstReceived = record.attributes.ApproximateFirstReceiveTimestamp
    ? new Date(Number(record.attributes.ApproximateFirstReceiveTimestamp)).toISOString()
    : '(unknown)';

  const hint = diagnose(payload, parseError);

  // ── Structured log ────────────────────────────────────────────────────────
  console.error(JSON.stringify({
    level:           'ERROR',
    message:         'Audit event failed to save after max retries',
    event_id:        eventId,
    tenant_id:       tenantId,
    model_version:   model,
    event_timestamp: eventTs,
    retry_count:     retryCount,
    sent_at:         sentAt,
    first_received:  firstReceived,
    sqs_message_id:  record.messageId,
    parse_error:     parseError,
    diagnosis_hint:  hint,
  }));

  // ── Operator SNS alert ────────────────────────────────────────────────────
  if (topicArn) {
    const payloadPreview = record.body.length > 800
      ? record.body.slice(0, 800) + '… [truncated]'
      : record.body;

    const operatorMessage = [
      'An audit event could not be saved after 5 retries and has been moved to the dead-letter queue.',
      '',
      '── Event details ──────────────────────────────────────────',
      `event_id:        ${eventId}`,
      `tenant_id:       ${tenantId}`,
      `model_version:   ${model}`,
      `event_timestamp: ${eventTs}`,
      '',
      '── Failure details ────────────────────────────────────────',
      `retry_count:     ${retryCount} attempts`,
      `first_queued:    ${sentAt}`,
      `first_attempted: ${firstReceived}`,
      `sqs_message_id:  ${record.messageId}`,
      ...(parseError ? [`parse_error:     ${parseError}`] : []),
      '',
      '── Diagnosis ──────────────────────────────────────────────',
      hint,
      '',
      '── Original payload ───────────────────────────────────────',
      payloadPreview,
      '',
      '── Next steps ─────────────────────────────────────────────',
      `1. Check CloudWatch Logs for ProcessorFn around ${sentAt}`,
      '2. The message is still in the DLQ and can be replayed once the',
      '   root cause is resolved (DLQ URL in CloudFormation Outputs).',
      '3. Use the status endpoint to confirm whether the record was partially written.',
    ].join('\n');

    try {
      await sns.send(new PublishCommand({
        TopicArn: topicArn,
        Subject:  `[AI Audit Ledger] FAILED to save audit event — tenant: ${tenantId}`,
        Message:  operatorMessage,
      }));
    } catch (e) {
      // Don't rethrow — a failed SNS publish must not cause Lambda to retry the DLQ message.
      console.error('[dlq-consumer] Failed to publish operator alert', e);
    }
  }

  // ── Tenant notification ───────────────────────────────────────────────────
  const contactsTable = process.env.TENANT_CONTACTS_TABLE;
  const senderEmail   = process.env.SES_SENDER_EMAIL;

  if (contactsTable && senderEmail && tenantId !== '(unknown)') {
    await notifyTenant(contactsTable, senderEmail, {
      event_type:  'dlq_failure',
      event_id:    eventId,
      tenant_id:   tenantId,
      subject:     '[AI Audit Ledger] Action required — audit event could not be saved',
      message: [
        'One of your audit events could not be saved to the ledger after multiple attempts.',
        '',
        `event_id:  ${eventId}`,
        `submitted: ${sentAt}`,
        '',
        'Please resubmit this event. If the problem persists, contact your account manager.',
        '',
        'You can verify whether the event was saved using the status endpoint:',
        `  GET /audit/events/${eventId}/status`,
      ].join('\n'),
      occurred_at: new Date().toISOString(),
    });
  }
}

// ── Diagnosis hints ───────────────────────────────────────────────────────────
function diagnose(payload: Record<string, unknown>, parseError: string | null): string {
  if (parseError) {
    return 'Payload could not be parsed. The message body may have been corrupted before enqueue. ' +
           'Check the ingest Lambda for any serialisation issues.';
  }
  if (!payload.event_id) {
    return 'event_id is missing. This should have been caught at ingestion — check whether ' +
           'validation was bypassed or the message was manually injected into SQS.';
  }
  if (!payload.tenant_id) {
    return 'tenant_id is missing. This is set by the ingest Lambda and should always be present. ' +
           'Check IngestFn logs for the original request.';
  }
  if (!payload.timestamp) {
    return 'timestamp field is missing. ProcessorFn uses this to build the DynamoDB sort key — ' +
           'a missing timestamp will cause the write to fail with a validation error.';
  }
  return 'Payload structure looks intact. Most likely causes: ' +
         '(a) DynamoDB throttling or capacity error, ' +
         '(b) S3 access denied or Object Lock configuration error, ' +
         '(c) a transient AWS service disruption. ' +
         'Check ProcessorFn CloudWatch Logs for the specific AWS error code.';
}
