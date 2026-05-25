/**
 * Admin Contacts Lambda — manages per-tenant notification config.
 *
 * This is how an email address or webhook URL gets into the product.
 * The admin calls these endpoints after onboarding a new tenant.
 *
 * Routes (all require the admin read key — tenant_id must be "*"):
 *   GET    /admin/tenants/{tenantId}/contact  — retrieve current config
 *   PUT    /admin/tenants/{tenantId}/contact  — set email and/or webhook_url
 *   DELETE /admin/tenants/{tenantId}/contact  — remove all contact config
 *
 * PUT body (JSON):
 *   { "email": "ops@acme.com" }
 *   { "webhook_url": "https://acme.com/hooks/audit" }
 *   { "email": "ops@acme.com", "webhook_url": "https://acme.com/hooks/audit" }
 *
 * Either field may be omitted to leave it unchanged (use DELETE to clear both).
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createKeyCache } from './lib/secretsCache';
import { getTenantContact, putTenantContact, deleteTenantContact, listTenantContacts } from './lib/tenantContacts';
import { json } from './lib/response';

const readKeyCache = createKeyCache('READ_KEY_SECRET_ARN');

const EMAIL_RE   = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HTTPS_RE   = /^https:\/\/.+/;

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const tableName = process.env.TENANT_CONTACTS_TABLE;
  if (!tableName) return json(500, { error: 'Server misconfiguration' });

  // ── Auth — admin only ─────────────────────────────────────────────────────
  const presentedKey = event.headers['x-api-key'] ?? event.headers['X-Api-Key'];
  if (!presentedKey) return json(401, { error: 'Missing API key' });

  let callerTenantId: string | null;
  try {
    callerTenantId = await readKeyCache.resolveTenantId(presentedKey);
  } catch (e) {
    console.error('Failed to load read keys', e);
    return json(500, { error: 'Server misconfiguration' });
  }

  if (!callerTenantId)    return json(401, { error: 'Invalid API key' });
  if (callerTenantId !== '*') return json(403, { error: 'Admin access required' });

  // ── Route ─────────────────────────────────────────────────────────────────
  const tenantId = event.pathParameters?.tenantId;
  const method   = event.httpMethod.toUpperCase();

  // List all tenant contacts — GET /admin/tenants
  if (!tenantId) {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    const contacts = await listTenantContacts(tableName);
    return json(200, { contacts, count: contacts.length });
  }

  if (method === 'GET') {
    const contact = await getTenantContact(tableName, tenantId);
    return contact
      ? json(200, contact)
      : json(404, { error: 'No contact configured for this tenant' });
  }

  if (method === 'DELETE') {
    await deleteTenantContact(tableName, tenantId);
    return json(200, { message: 'Contact removed', tenant_id: tenantId });
  }

  if (method === 'PUT') {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
    } catch {
      return json(400, { error: 'Invalid JSON body' });
    }

    const { email, webhook_url } = body;

    if (email !== undefined) {
      if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
        return json(400, { error: 'email must be a valid email address' });
      }
    }

    if (webhook_url !== undefined) {
      if (typeof webhook_url !== 'string' || !HTTPS_RE.test(webhook_url)) {
        return json(400, { error: 'webhook_url must be an HTTPS URL' });
      }
    }

    if (email === undefined && webhook_url === undefined) {
      return json(400, { error: 'Provide at least one of: email, webhook_url' });
    }

    // Merge with existing record so a PUT with only email does not wipe the webhook
    const existing = await getTenantContact(tableName, tenantId) ?? { tenant_id: tenantId };
    const updated = {
      ...existing,
      ...(email       !== undefined && { email:       email       as string }),
      ...(webhook_url !== undefined && { webhook_url: webhook_url as string }),
    };

    await putTenantContact(tableName, updated);
    console.info('[admin-contacts] Contact updated', { tenantId, fields: Object.keys(body) });
    return json(200, { message: 'Contact updated', contact: updated });
  }

  return json(405, { error: 'Method not allowed' });
}
