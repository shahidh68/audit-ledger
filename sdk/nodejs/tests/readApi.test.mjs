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

import { verifyCompleteness } from '../src/readApi.mjs';
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
