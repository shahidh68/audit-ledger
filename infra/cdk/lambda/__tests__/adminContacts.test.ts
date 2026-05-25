import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createKeyCache } from '../lib/secretsCache';
import * as tenantContacts from '../lib/tenantContacts';

jest.mock('../lib/secretsCache', () => ({
  createKeyCache: jest.fn(),
}));

jest.mock('../lib/tenantContacts');

const mockResolveTenantId = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TENANT_CONTACTS_TABLE = 'test-table';
  (createKeyCache as jest.Mock).mockReturnValue({ resolveTenantId: mockResolveTenantId });
  mockResolveTenantId.mockResolvedValue('*'); // admin by default
});

afterEach(() => {
  delete process.env.TENANT_CONTACTS_TABLE;
});

// Re-import handler after mocks are in place
async function getHandler() {
  jest.resetModules();
  // Re-apply mocks after resetModules
  jest.mock('../lib/secretsCache', () => ({
    createKeyCache: jest.fn().mockReturnValue({ resolveTenantId: mockResolveTenantId }),
  }));
  jest.mock('../lib/tenantContacts');
  const mod = await import('../adminContacts');
  return mod.handler;
}

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    headers: { 'x-api-key': 'admin-key' },
    pathParameters: null,
    body: null,
    ...overrides,
  } as APIGatewayProxyEvent;
}

// ── Auth tests ────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('returns 500 when TENANT_CONTACTS_TABLE env var is missing', async () => {
    delete process.env.TENANT_CONTACTS_TABLE;
    const { handler } = await import('../adminContacts');
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: 'Server misconfiguration' });
  });

  it('returns 401 when x-api-key header is missing', async () => {
    const { handler } = await import('../adminContacts');
    const result = await handler(makeEvent({ headers: {} }));
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body)).toEqual({ error: 'Missing API key' });
  });

  it('returns 401 when key resolves to null', async () => {
    mockResolveTenantId.mockResolvedValue(null);
    const { handler } = await import('../adminContacts');
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body)).toEqual({ error: 'Invalid API key' });
  });

  it('returns 403 when key resolves to a non-admin tenant', async () => {
    mockResolveTenantId.mockResolvedValue('some-tenant');
    const { handler } = await import('../adminContacts');
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ error: 'Admin access required' });
  });

  it('returns 500 when resolveTenantId throws', async () => {
    mockResolveTenantId.mockRejectedValue(new Error('Secrets Manager down'));
    const { handler } = await import('../adminContacts');
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: 'Server misconfiguration' });
  });
});

// ── GET /admin/tenants (list all, no tenantId) ────────────────────────────────

describe('GET /admin/tenants (no tenantId)', () => {
  it('returns 200 with contacts list and count', async () => {
    const mockContacts = [
      { tenant_id: 'acme', email: 'a@acme.com' },
      { tenant_id: 'beta', email: 'b@beta.com' },
    ];
    (tenantContacts.listTenantContacts as jest.Mock).mockResolvedValue(mockContacts);
    const { handler } = await import('../adminContacts');
    const result = await handler(makeEvent({ pathParameters: null }));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.contacts).toEqual(mockContacts);
    expect(body.count).toBe(2);
  });

  it('returns 405 for non-GET method without tenantId', async () => {
    const { handler } = await import('../adminContacts');
    const result = await handler(makeEvent({ httpMethod: 'POST', pathParameters: null }));
    expect(result.statusCode).toBe(405);
  });
});

// ── GET /admin/tenants/{tenantId}/contact ─────────────────────────────────────

describe('GET /admin/tenants/{tenantId}/contact', () => {
  it('returns 200 with the contact when it exists', async () => {
    const mockContact = { tenant_id: 'acme-hr', email: 'hr@acme.com' };
    (tenantContacts.getTenantContact as jest.Mock).mockResolvedValue(mockContact);
    const { handler } = await import('../adminContacts');
    const result = await handler(makeEvent({ pathParameters: { tenantId: 'acme-hr' } }));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual(mockContact);
  });

  it('returns 404 when contact is not found', async () => {
    (tenantContacts.getTenantContact as jest.Mock).mockResolvedValue(null);
    const { handler } = await import('../adminContacts');
    const result = await handler(makeEvent({ pathParameters: { tenantId: 'unknown-tenant' } }));
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ error: 'No contact configured for this tenant' });
  });
});

// ── DELETE /admin/tenants/{tenantId}/contact ──────────────────────────────────

describe('DELETE /admin/tenants/{tenantId}/contact', () => {
  it('returns 200 with removal message and calls deleteTenantContact', async () => {
    (tenantContacts.deleteTenantContact as jest.Mock).mockResolvedValue(undefined);
    const { handler } = await import('../adminContacts');
    const result = await handler(
      makeEvent({ httpMethod: 'DELETE', pathParameters: { tenantId: 'acme-hr' } }),
    );
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ message: 'Contact removed', tenant_id: 'acme-hr' });
    expect(tenantContacts.deleteTenantContact).toHaveBeenCalledWith('test-table', 'acme-hr');
  });
});

// ── PUT /admin/tenants/{tenantId}/contact ─────────────────────────────────────

describe('PUT /admin/tenants/{tenantId}/contact', () => {
  beforeEach(() => {
    (tenantContacts.getTenantContact as jest.Mock).mockResolvedValue(null);
    (tenantContacts.putTenantContact as jest.Mock).mockResolvedValue(undefined);
  });

  const putEvent = (body: string | null, tenantId = 'acme-hr') =>
    makeEvent({ httpMethod: 'PUT', pathParameters: { tenantId }, body });

  it('returns 400 for invalid JSON body', async () => {
    const { handler } = await import('../adminContacts');
    const result = await handler(putEvent('{invalid json}'));
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when neither email nor webhook_url provided', async () => {
    const { handler } = await import('../adminContacts');
    const result = await handler(putEvent(JSON.stringify({ other: 'field' })));
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 with message containing "email" for invalid email format', async () => {
    const { handler } = await import('../adminContacts');
    const result = await handler(putEvent(JSON.stringify({ email: 'not-an-email' })));
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('email');
  });

  it('returns 400 with message containing "webhook_url" for http (non-https) webhook', async () => {
    const { handler } = await import('../adminContacts');
    const result = await handler(putEvent(JSON.stringify({ webhook_url: 'http://example.com/hook' })));
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('webhook_url');
  });

  it('returns 200 with email set for valid email-only payload', async () => {
    const { handler } = await import('../adminContacts');
    const result = await handler(putEvent(JSON.stringify({ email: 'ops@acme.com' })));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.contact.email).toBe('ops@acme.com');
  });

  it('returns 200 with webhook_url set for valid webhook-only payload', async () => {
    const { handler } = await import('../adminContacts');
    const result = await handler(putEvent(JSON.stringify({ webhook_url: 'https://acme.com/hook' })));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.contact.webhook_url).toBe('https://acme.com/hook');
  });

  it('returns 200 with both fields set when both are valid', async () => {
    const { handler } = await import('../adminContacts');
    const result = await handler(
      putEvent(JSON.stringify({ email: 'ops@acme.com', webhook_url: 'https://acme.com/hook' })),
    );
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.contact.email).toBe('ops@acme.com');
    expect(body.contact.webhook_url).toBe('https://acme.com/hook');
  });

  it('merges: PUT with email only does NOT wipe existing webhook_url', async () => {
    (tenantContacts.getTenantContact as jest.Mock).mockResolvedValue({
      tenant_id: 'acme',
      webhook_url: 'https://hook.com',
    });
    const { handler } = await import('../adminContacts');
    const result = await handler(
      makeEvent({
        httpMethod: 'PUT',
        pathParameters: { tenantId: 'acme' },
        body: JSON.stringify({ email: 'new@test.com' }),
      }),
    );
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.contact.email).toBe('new@test.com');
    expect(body.contact.webhook_url).toBe('https://hook.com');
  });

  it('returns 405 for unsupported method', async () => {
    const { handler } = await import('../adminContacts');
    const result = await handler(
      makeEvent({ httpMethod: 'PATCH', pathParameters: { tenantId: 'acme-hr' } }),
    );
    expect(result.statusCode).toBe(405);
  });
});
