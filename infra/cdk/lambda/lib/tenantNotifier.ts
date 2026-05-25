/**
 * tenantNotifier — delivers notifications to a tenant via email (SES) and/or
 * webhook (HTTPS POST), based on the contact record stored in DynamoDB.
 *
 * Both channels are fire-and-forget: errors are logged but never thrown so a
 * failed notification never rolls back or blocks the calling operation.
 *
 * Email:   uses SES SendEmail. The sender address must be verified in SES.
 *          In SES sandbox mode, the recipient must also be verified.
 *          Request production SES access to send to any address.
 *
 * Webhook: HTTPS POST with a JSON body. The tenant endpoint must respond with
 *          any 2xx status within 5 seconds. Non-2xx or timeout is logged only.
 */
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { getTenantContact } from './tenantContacts';

const ses = new SESClient({});

export interface TenantNotification {
  /** Machine-readable event type for webhook consumers. */
  event_type: 'dlq_failure' | 'tamper_detected' | 'record_restored';
  event_id:   string;
  tenant_id:  string;
  /** Email subject line. */
  subject:    string;
  /** Plain-text email body shown to a human reader. */
  message:    string;
  /** ISO timestamp of when the notification was generated. */
  occurred_at: string;
}

/**
 * Notify a tenant via every channel they have configured.
 * Silently no-ops if the tenant has no contact record.
 */
export async function notifyTenant(
  contactsTable: string,
  senderEmail:   string,
  notification:  TenantNotification,
): Promise<void> {
  let contact;
  try {
    contact = await getTenantContact(contactsTable, notification.tenant_id);
  } catch (e) {
    console.error('[tenantNotifier] Failed to read contact record', {
      tenant_id: notification.tenant_id,
      error: String(e),
    });
    return;
  }

  if (!contact) {
    console.info('[tenantNotifier] No contact configured for tenant', { tenant_id: notification.tenant_id });
    return;
  }

  await Promise.all([
    contact.email       ? sendEmail(senderEmail, contact.email, notification)    : Promise.resolve(),
    contact.webhook_url ? sendWebhook(contact.webhook_url, notification)          : Promise.resolve(),
  ]);
}

// ── Email delivery (SES) ──────────────────────────────────────────────────────

async function sendEmail(
  from:         string,
  to:           string,
  notification: TenantNotification,
): Promise<void> {
  try {
    await ses.send(new SendEmailCommand({
      Source: from,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: notification.subject, Charset: 'UTF-8' },
        Body:    { Text: { Data: notification.message, Charset: 'UTF-8' } },
      },
    }));
    console.info('[tenantNotifier] Email sent', { tenant_id: notification.tenant_id, to });
  } catch (e) {
    console.error('[tenantNotifier] Failed to send email', {
      tenant_id: notification.tenant_id,
      to,
      error: String(e),
    });
  }
}

// ── Webhook delivery (HTTPS POST) ─────────────────────────────────────────────

async function sendWebhook(
  url:          string,
  notification: TenantNotification,
): Promise<void> {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 5_000);

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(notification),
      signal:  controller.signal,
    });

    if (!res.ok) {
      console.warn('[tenantNotifier] Webhook returned non-2xx', {
        tenant_id: notification.tenant_id,
        url,
        status: res.status,
      });
    } else {
      console.info('[tenantNotifier] Webhook delivered', { tenant_id: notification.tenant_id, url });
    }
  } catch (e) {
    const reason = (e as Error).name === 'AbortError' ? 'timeout (5s)' : String(e);
    console.error('[tenantNotifier] Webhook delivery failed', {
      tenant_id: notification.tenant_id,
      url,
      reason,
    });
  } finally {
    clearTimeout(timeout);
  }
}
