/**
 * Unit tests for sdk/nodejs/src/readApi.mjs.
 *
 * Run from the nodejs SDK root:
 *   node --test tests/readApi.test.mjs
 *
 * Network is mocked with a fake fetch — no real HTTP calls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyDecision, verifyCompleteness, listDecisions } from '../src/readApi.mjs';
import { AuditLedgerError } from '../src/index.mjs';

function fakeFetch({ status = 200, body = {}, captureUrl } = {}) {
  return async (url, _init) => {
    if (captureUrl) captureUrl.value = url;
    return {
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
}

test('verifyCompleteness: happy path returns parsed result', async () => {
  const payload = {
    tenant_id: 't1',
    range: { from: 1, to: 5 },
    expected_count: 5,
    found_count: 5,
    missing: [],
    note: 'all good',
  };
  const got = await verifyCompleteness({
    apiUrl: 'https://example.com',
    readKey: 'key',
    fetchImpl: fakeFetch({ status: 200, body: payload }),
  });
  assert.deepEqual(got, payload);
});

test('verifyCompleteness: passes from/to/tenantId as query params', async () => {
  const url = { value: '' };
  await verifyCompleteness({
    apiUrl: 'https://example.com/',
    readKey: 'key',
    from: 10,
    to: 20,
    tenantId: 'tenant-x',
    fetchImpl: fakeFetch({ status: 200, body: {}, captureUrl: url }),
  });
  assert.match(url.value, /\/audit\/verify-completeness\?/);
  assert.match(url.value, /from=10/);
  assert.match(url.value, /to=20/);
  assert.match(url.value, /tenant_id=tenant-x/);
});

test('verifyCompleteness: trims trailing slash from apiUrl', async () => {
  const url = { value: '' };
  await verifyCompleteness({
    apiUrl: 'https://example.com////',
    readKey: 'key',
    fetchImpl: fakeFetch({ status: 200, body: {}, captureUrl: url }),
  });
  assert.equal(url.value, 'https://example.com/audit/verify-completeness');
});

test('verifyCompleteness: 4xx is terminal and surfaces body', async () => {
  await assert.rejects(
    verifyCompleteness({
      apiUrl: 'https://example.com',
      readKey: 'bad-key',
      fetchImpl: fakeFetch({ status: 401, body: 'invalid key' }),
    }),
    (err) => {
      assert.ok(err instanceof AuditLedgerError);
      assert.equal(err.status, 401);
      assert.match(err.message, /invalid key/);
      return true;
    },
  );
});

test('verifyCompleteness: retries on 5xx then succeeds', async () => {
  let calls = 0;
  const flakyFetch = async () => {
    calls++;
    if (calls < 2) {
      return {
        ok: false,
        status: 503,
        json: async () => ({}),
        text: async () => 'svc unavailable',
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ tenant_id: 't', range: { from: 1, to: 1 }, expected_count: 1, found_count: 1, missing: [], note: 'ok' }),
      text: async () => '',
    };
  };
  const got = await verifyCompleteness({
    apiUrl: 'https://example.com',
    readKey: 'key',
    retries: 3,
    fetchImpl: flakyFetch,
  });
  assert.equal(calls, 2);
  assert.equal(got.tenant_id, 't');
});

test('verifyCompleteness: omits query string when no params', async () => {
  const url = { value: '' };
  await verifyCompleteness({
    apiUrl: 'https://example.com',
    readKey: 'key',
    fetchImpl: fakeFetch({ status: 200, body: {}, captureUrl: url }),
  });
  assert.equal(url.value, 'https://example.com/audit/verify-completeness');
});

// ── verifyDecision ─────────────────────────────────────────────────────────

test('verifyDecision: hits the /history endpoint with the event ID', async () => {
  const url = { value: '' };
  await verifyDecision({
    apiUrl: 'https://example.com',
    readKey: 'key',
    eventId: 'aaaa-bbbb-cccc-dddd',
    fetchImpl: fakeFetch({
      status: 200,
      body: { event_id: 'aaaa-bbbb-cccc-dddd', integrity_verified: true, integrity_note: 'ok', current_record: {}, archived_record: {} },
      captureUrl: url,
    }),
  });
  assert.equal(url.value, 'https://example.com/audit/events/aaaa-bbbb-cccc-dddd/history');
});

test('verifyDecision: url-encodes the event ID', async () => {
  const url = { value: '' };
  await verifyDecision({
    apiUrl: 'https://example.com',
    readKey: 'key',
    eventId: 'has spaces & slashes/here',
    fetchImpl: fakeFetch({ status: 200, body: { event_id: 'x' }, captureUrl: url }),
  });
  assert.match(url.value, /has%20spaces%20%26%20slashes%2Fhere\/history$/);
});

test('verifyDecision: throws when eventId is missing', async () => {
  await assert.rejects(
    verifyDecision({
      apiUrl: 'https://example.com',
      readKey: 'key',
      eventId: '',
      fetchImpl: fakeFetch({ status: 200, body: {} }),
    }),
    (err) => err instanceof AuditLedgerError && /eventId is required/.test(err.message),
  );
});

test('verifyDecision: 4xx is terminal and surfaces body', async () => {
  await assert.rejects(
    verifyDecision({
      apiUrl: 'https://example.com',
      readKey: 'bad-key',
      eventId: 'abc',
      fetchImpl: fakeFetch({ status: 401, body: 'invalid key' }),
    }),
    (err) => err instanceof AuditLedgerError && err.status === 401,
  );
});

test('verifyDecision: returns parsed body on 200', async () => {
  const payload = {
    event_id: 'abc',
    integrity_verified: true,
    integrity_note: 'match',
    current_record: { event_id: 'abc', sequence_no: 5 },
    archived_record: { event_id: 'abc', sequence_no: 5 },
  };
  const got = await verifyDecision({
    apiUrl: 'https://example.com',
    readKey: 'key',
    eventId: 'abc',
    fetchImpl: fakeFetch({ status: 200, body: payload }),
  });
  assert.deepEqual(got, payload);
  assert.equal(got.archived_record.sequence_no, 5);
});

// ── listDecisions ──────────────────────────────────────────────────────────

test('listDecisions: hits the /logs endpoint and returns items', async () => {
  const url = { value: '' };
  const payload = {
    items: [{ event_id: 'a' }, { event_id: 'b' }],
    count: 2,
    tenant_id: 't1',
  };
  const got = await listDecisions({
    apiUrl: 'https://example.com',
    readKey: 'key',
    fetchImpl: fakeFetch({ status: 200, body: payload, captureUrl: url }),
  });
  assert.equal(url.value, 'https://example.com/audit/logs');
  assert.deepEqual(got, payload);
});

test('listDecisions: passes from/to as query params', async () => {
  const url = { value: '' };
  await listDecisions({
    apiUrl: 'https://example.com',
    readKey: 'key',
    from: '2026-01-01T00:00:00Z',
    to: '2026-12-31T23:59:59Z',
    fetchImpl: fakeFetch({ status: 200, body: { items: [], count: 0 }, captureUrl: url }),
  });
  assert.match(url.value, /from=2026-01-01T00%3A00%3A00Z/);
  assert.match(url.value, /to=2026-12-31T23%3A59%3A59Z/);
});

test('listDecisions: 4xx is terminal', async () => {
  await assert.rejects(
    listDecisions({
      apiUrl: 'https://example.com',
      readKey: 'bad-key',
      fetchImpl: fakeFetch({ status: 403, body: 'forbidden' }),
    }),
    (err) => err instanceof AuditLedgerError && err.status === 403,
  );
});
