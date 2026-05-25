import { mockClient } from 'aws-sdk-client-mock';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { notifyTenant, TenantNotification } from '../lib/tenantNotifier';
import * as tenantContacts from '../lib/tenantContacts';

jest.mock('../lib/tenantContacts');

const sesMock = mockClient(SESClient);

const NOTIFICATION: TenantNotification = {
  event_type: 'tamper_detected',
  event_id: '550e8400-e29b-41d4-a716-446655440000',
  tenant_id: 'acme-hr',
  subject: 'Test subject',
  message: 'Test message',
  occurred_at: '2026-04-14T10:00:00Z',
};

const CONTACTS_TABLE = 'test-contacts-table';
const SENDER_EMAIL = 'noreply@audit.example.com';

beforeEach(() => {
  jest.clearAllMocks();
  sesMock.reset();
  global.fetch = jest.fn();
});

// ── 1. No contact record ──────────────────────────────────────────────────────

it('resolves without calling SES or fetch when getTenantContact returns null', async () => {
  (tenantContacts.getTenantContact as jest.Mock).mockResolvedValue(null);

  await expect(notifyTenant(CONTACTS_TABLE, SENDER_EMAIL, NOTIFICATION)).resolves.toBeUndefined();
  expect(sesMock.calls()).toHaveLength(0);
  expect(global.fetch).not.toHaveBeenCalled();
});

// ── 2. getTenantContact throws ────────────────────────────────────────────────

it('resolves without throwing when getTenantContact throws', async () => {
  (tenantContacts.getTenantContact as jest.Mock).mockRejectedValue(new Error('DynamoDB error'));

  await expect(notifyTenant(CONTACTS_TABLE, SENDER_EMAIL, NOTIFICATION)).resolves.toBeUndefined();
});

// ── 3. Email-only contact ─────────────────────────────────────────────────────

it('calls SES SendEmailCommand but not fetch when only email is configured', async () => {
  (tenantContacts.getTenantContact as jest.Mock).mockResolvedValue({
    tenant_id: 'acme-hr',
    email: 'ops@acme.com',
  });
  sesMock.on(SendEmailCommand).resolves({});

  await notifyTenant(CONTACTS_TABLE, SENDER_EMAIL, NOTIFICATION);

  expect(sesMock.calls()).toHaveLength(1);
  const call = sesMock.calls()[0];
  const input = call.args[0].input as {
    Destination: { ToAddresses: string[] };
    Message: { Subject: { Data: string }; Body: { Text: { Data: string } } };
  };
  expect(input.Destination.ToAddresses).toContain('ops@acme.com');
  expect(input.Message.Subject.Data).toBe(NOTIFICATION.subject);
  expect(input.Message.Body.Text.Data).toBe(NOTIFICATION.message);
  expect(global.fetch).not.toHaveBeenCalled();
});

// ── 4. Webhook-only contact ───────────────────────────────────────────────────

it('calls fetch but not SES when only webhook_url is configured', async () => {
  (tenantContacts.getTenantContact as jest.Mock).mockResolvedValue({
    tenant_id: 'acme-hr',
    webhook_url: 'https://acme.com/hook',
  });
  (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

  await notifyTenant(CONTACTS_TABLE, SENDER_EMAIL, NOTIFICATION);

  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
  expect(url).toBe('https://acme.com/hook');
  expect(options.method).toBe('POST');
  expect(options.headers['Content-Type']).toBe('application/json');
  expect(sesMock.calls()).toHaveLength(0);
});

// ── 5. Both email and webhook configured ──────────────────────────────────────

it('calls both SES and fetch when both email and webhook_url are configured', async () => {
  (tenantContacts.getTenantContact as jest.Mock).mockResolvedValue({
    tenant_id: 'acme-hr',
    email: 'ops@acme.com',
    webhook_url: 'https://acme.com/hook',
  });
  sesMock.on(SendEmailCommand).resolves({});
  (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

  await notifyTenant(CONTACTS_TABLE, SENDER_EMAIL, NOTIFICATION);

  expect(sesMock.calls()).toHaveLength(1);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

// ── 6. SES throws ─────────────────────────────────────────────────────────────

it('resolves without throwing when SES throws', async () => {
  (tenantContacts.getTenantContact as jest.Mock).mockResolvedValue({
    tenant_id: 'acme-hr',
    email: 'ops@acme.com',
  });
  sesMock.on(SendEmailCommand).rejects(new Error('SES error'));

  await expect(notifyTenant(CONTACTS_TABLE, SENDER_EMAIL, NOTIFICATION)).resolves.toBeUndefined();
});

// ── 7. Webhook returns non-2xx ────────────────────────────────────────────────

it('resolves without throwing when webhook returns non-2xx status', async () => {
  (tenantContacts.getTenantContact as jest.Mock).mockResolvedValue({
    tenant_id: 'acme-hr',
    webhook_url: 'https://acme.com/hook',
  });
  (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });

  await expect(notifyTenant(CONTACTS_TABLE, SENDER_EMAIL, NOTIFICATION)).resolves.toBeUndefined();
});

// ── 8. Webhook AbortError (timeout) ──────────────────────────────────────────

it('resolves without throwing when fetch rejects with AbortError', async () => {
  (tenantContacts.getTenantContact as jest.Mock).mockResolvedValue({
    tenant_id: 'acme-hr',
    webhook_url: 'https://acme.com/hook',
  });
  (global.fetch as jest.Mock).mockRejectedValue(
    Object.assign(new Error('aborted'), { name: 'AbortError' }),
  );

  await expect(notifyTenant(CONTACTS_TABLE, SENDER_EMAIL, NOTIFICATION)).resolves.toBeUndefined();
});

// ── 9. Webhook payload shape ──────────────────────────────────────────────────

it('sends a webhook body containing all expected notification fields', async () => {
  (tenantContacts.getTenantContact as jest.Mock).mockResolvedValue({
    tenant_id: 'acme-hr',
    webhook_url: 'https://acme.com/hook',
  });
  (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

  await notifyTenant(CONTACTS_TABLE, SENDER_EMAIL, NOTIFICATION);

  const [, options] = (global.fetch as jest.Mock).mock.calls[0];
  const payload = JSON.parse(options.body);
  expect(payload.event_type).toBe(NOTIFICATION.event_type);
  expect(payload.event_id).toBe(NOTIFICATION.event_id);
  expect(payload.tenant_id).toBe(NOTIFICATION.tenant_id);
  expect(payload.subject).toBe(NOTIFICATION.subject);
  expect(payload.message).toBe(NOTIFICATION.message);
  expect(payload.occurred_at).toBe(NOTIFICATION.occurred_at);
});

// ── 10. SES Source email ──────────────────────────────────────────────────────

it('uses the senderEmail arg as the SES Source address', async () => {
  (tenantContacts.getTenantContact as jest.Mock).mockResolvedValue({
    tenant_id: 'acme-hr',
    email: 'ops@acme.com',
  });
  sesMock.on(SendEmailCommand).resolves({});

  await notifyTenant(CONTACTS_TABLE, 'custom-sender@audit.example.com', NOTIFICATION);

  const call = sesMock.calls()[0];
  const input = call.args[0].input as { Source: string };
  expect(input.Source).toBe('custom-sender@audit.example.com');
});
