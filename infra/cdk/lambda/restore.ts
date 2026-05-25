/**
 * Restore Lambda — processes single-use approval links from mismatch alert emails.
 *
 * Flow:
 *   1. Extract the token from the URL path.
 *   2. Claim the token atomically (prevents replay).
 *   3. Fetch the sealed S3 copy — the trusted source of truth.
 *   4. Overwrite the DynamoDB record with the S3 copy.
 *   5. Publish a confirmation email via SNS.
 *   6. Return an HTML page shown in the operator's browser.
 *
 * Environment variables (set by CDK):
 *   RESTORE_APPROVAL_TABLE — DynamoDB table for approval tokens
 *   AUDIT_TABLE            — DynamoDB audit table
 *   AUDIT_BUCKET           — S3 audit archive bucket
 *   SNS_TOPIC_ARN          — topic for the confirmation email
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { claimToken, InvalidTokenError, type TokenPayload } from './lib/approvalTokens';
import { fetchArchivedRecord } from './lib/auditRepository';
import { restoreAuditRecord } from './lib/restoreRepository';
import { notifyTenant } from './lib/tenantNotifier';

const sns = new SNSClient({});

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const token = event.pathParameters?.token ?? '';

  const approvalTable = process.env.RESTORE_APPROVAL_TABLE;
  const auditTable    = process.env.AUDIT_TABLE;
  const auditBucket   = process.env.AUDIT_BUCKET;
  const snsTopicArn   = process.env.SNS_TOPIC_ARN;

  if (!approvalTable || !auditTable || !auditBucket || !snsTopicArn) {
    console.error('[restore] Missing required environment variables');
    return htmlPage(500, 'Configuration error', 'Server is misconfigured. Contact the administrator.');
  }

  try {
    const payload = await claimToken(approvalTable, token);

    const { record: s3Record, note } = await fetchArchivedRecord(auditBucket, payload.tenant_id, payload.event_id);
    if (!s3Record) {
      return htmlPage(500, 'Restore failed', `S3 archive record could not be retrieved. ${note}`);
    }

    await restoreAuditRecord(auditTable, s3Record);
    await publishConfirmation(snsTopicArn, payload);

    // Notify the tenant — no AWS internals, just confirmation of the outcome.
    const contactsTable = process.env.TENANT_CONTACTS_TABLE;
    const senderEmail   = process.env.SES_SENDER_EMAIL;
    const restoredAt    = new Date().toISOString();

    if (contactsTable && senderEmail) {
      await notifyTenant(contactsTable, senderEmail, {
        event_type:  'record_restored',
        event_id:    payload.event_id,
        tenant_id:   payload.tenant_id,
        subject:     '[AI Audit Ledger] Audit record restored — no further action required',
        message: [
          'Your audit record has been restored from the verified sealed archive.',
          'The record now matches its original state as recorded at the time of submission.',
          '',
          `event_id:    ${payload.event_id}`,
          `restored_at: ${restoredAt}`,
          '',
          'You can verify the integrity of this record at any time using:',
          `  GET /audit/events/${payload.event_id}/history`,
        ].join('\n'),
        occurred_at: restoredAt,
      });
    }

    console.log(`[restore] event_id=${payload.event_id} tenant_id=${payload.tenant_id} restored from S3`);

    return htmlPage(
      200,
      'Record restored',
      `event_id <strong>${payload.event_id}</strong> for tenant <strong>${payload.tenant_id}</strong>
       has been restored from the sealed S3 archive. A confirmation email has been sent.`,
    );
  } catch (e) {
    if (e instanceof InvalidTokenError) {
      return htmlPage(410, 'Link invalid or expired', 'This restore link has already been used or has expired. Links are valid for 48 hours and can only be used once.');
    }
    console.error('[restore] Unexpected error', e);
    return htmlPage(500, 'Restore failed', 'An unexpected error occurred. Check CloudWatch logs for details.');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function publishConfirmation(topicArn: string, payload: TokenPayload): Promise<void> {
  await sns.send(new PublishCommand({
    TopicArn: topicArn,
    Subject:  '[AI Audit Ledger] Record restored from archive',
    Message:  [
      'An audit record has been restored from the sealed S3 archive.',
      '',
      `event_id:     ${payload.event_id}`,
      `tenant_id:    ${payload.tenant_id}`,
      `Requested at: ${payload.requested_at}`,
      `Restored at:  ${new Date().toISOString()}`,
      '',
      'The DynamoDB record now matches the S3 archive.',
    ].join('\n'),
  }));
}

function htmlPage(statusCode: number, title: string, message: string): APIGatewayProxyResult {
  const colour = statusCode === 200 ? '#2e7d32' : '#c62828';
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html' },
    body: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — AI Audit Ledger</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 24px; color: #333; }
    h1   { color: ${colour}; }
    p    { line-height: 1.6; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>${message}</p>
</body>
</html>`,
  };
}
