/**
 * AI Audit Ledger — End-to-end test suite
 *
 * Tests every API behaviour against the live deployed system.
 * No extra dependencies — uses Node.js built-in fetch (Node 18+).
 *
 * Usage:
 *   1. Fill in your values in tests/config.mjs
 *   2. Run: node tests/run-tests.mjs
 */

import { config } from './config.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_EVENT_ID       = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5';
const VALID_SHA256         = 'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';
const VALID_TIMESTAMP      = new Date().toISOString();

let passed = 0;
let failed = 0;
const failures = [];

function pass(name) {
  console.log(`  ✓  ${name}`);
  passed++;
}

function fail(name, reason) {
  console.log(`  ✗  ${name}`);
  console.log(`       → ${reason}`);
  failed++;
  failures.push({ name, reason });
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, headers: res.headers, body: json };
}

async function get(url, headers = {}) {
  const res = await fetch(url, { headers });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, headers: res.headers, body: json };
}

function validPayload(overrides = {}) {
  return {
    event_id:           VALID_EVENT_ID,
    timestamp:          VALID_TIMESTAMP,
    model_version:      'gpt-4o',
    system_prompt_hash: VALID_SHA256,
    input_data_hash:    VALID_SHA256,
    ai_decision_output: { decision: 'approved', score: 87 },
    human_in_loop:      false,
    ...overrides,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Validate config ───────────────────────────────────────────────────────────

function checkConfig() {
  const missing = Object.entries(config)
    .filter(([, v]) => v.startsWith('REPLACE_WITH'))
    .map(([k]) => k);

  if (missing.length > 0) {
    console.error('\n  ERROR: Fill in the following values in tests/config.mjs before running:\n');
    missing.forEach(k => console.error(`    - ${k}`));
    console.error('');
    process.exit(1);
  }
}

// ── Test suites ───────────────────────────────────────────────────────────────

async function testIngestAuth() {
  console.log('\n── Ingest: Authentication ──────────────────────────────────────');

  // No API key
  const r1 = await post(config.INGEST_URL, validPayload());
  r1.status === 401
    ? pass('No API key → 401')
    : fail('No API key → 401', `got ${r1.status}`);

  // Wrong API key
  const r2 = await post(config.INGEST_URL, validPayload(), { 'x-api-key': 'totally-wrong-key' });
  r2.status === 401
    ? pass('Invalid API key → 401')
    : fail('Invalid API key → 401', `got ${r2.status}`);

  // Correct API key
  const r3 = await post(config.INGEST_URL, validPayload(), { 'x-api-key': config.TENANT_KEY });
  r3.status !== 401
    ? pass('Valid API key → not 401')
    : fail('Valid API key → not 401', `got ${r3.status}`);
}

async function testIngestValidation() {
  console.log('\n── Ingest: Payload validation ──────────────────────────────────');

  const h = { 'x-api-key': config.TENANT_KEY };

  // Valid payload
  const r1 = await post(config.INGEST_URL, validPayload(), h);
  r1.status === 202
    ? pass('Valid payload → 202')
    : fail('Valid payload → 202', `got ${r1.status} — ${JSON.stringify(r1.body)}`);

  // event_id not UUID v4
  const r2 = await post(config.INGEST_URL, validPayload({ event_id: 'not-a-uuid' }), h);
  r2.status === 400
    ? pass('Invalid event_id → 400')
    : fail('Invalid event_id → 400', `got ${r2.status}`);

  // event_id UUID v1 (wrong version)
  const r3 = await post(config.INGEST_URL, validPayload({ event_id: 'a1b2c3d4-e5f6-1a7b-8c9d-e0f1a2b3c4d5' }), h);
  r3.status === 400
    ? pass('UUID v1 event_id → 400')
    : fail('UUID v1 event_id → 400', `got ${r3.status}`);

  // Missing timestamp
  const r4 = await post(config.INGEST_URL, validPayload({ timestamp: '' }), h);
  r4.status === 400
    ? pass('Empty timestamp → 400')
    : fail('Empty timestamp → 400', `got ${r4.status}`);

  // Missing model_version
  const r5 = await post(config.INGEST_URL, validPayload({ model_version: '' }), h);
  r5.status === 400
    ? pass('Empty model_version → 400')
    : fail('Empty model_version → 400', `got ${r5.status}`);

  // system_prompt_hash not SHA-256 (too short)
  const r6 = await post(config.INGEST_URL, validPayload({ system_prompt_hash: 'abc123' }), h);
  r6.status === 400
    ? pass('Invalid system_prompt_hash → 400')
    : fail('Invalid system_prompt_hash → 400', `got ${r6.status}`);

  // input_data_hash not SHA-256 (contains invalid chars)
  const r7 = await post(config.INGEST_URL, validPayload({ input_data_hash: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }), h);
  r7.status === 400
    ? pass('Invalid input_data_hash → 400')
    : fail('Invalid input_data_hash → 400', `got ${r7.status}`);

  // ai_decision_output is an array (not allowed)
  const r8 = await post(config.INGEST_URL, validPayload({ ai_decision_output: [1, 2, 3] }), h);
  r8.status === 400
    ? pass('ai_decision_output as array → 400')
    : fail('ai_decision_output as array → 400', `got ${r8.status}`);

  // ai_decision_output is a string (not allowed)
  const r9 = await post(config.INGEST_URL, validPayload({ ai_decision_output: 'approved' }), h);
  r9.status === 400
    ? pass('ai_decision_output as string → 400')
    : fail('ai_decision_output as string → 400', `got ${r9.status}`);

  // human_in_loop is a string (not boolean)
  const r10 = await post(config.INGEST_URL, validPayload({ human_in_loop: 'yes' }), h);
  r10.status === 400
    ? pass('human_in_loop as string → 400')
    : fail('human_in_loop as string → 400', `got ${r10.status}`);

  // human_in_loop is a number
  const r11 = await post(config.INGEST_URL, validPayload({ human_in_loop: 1 }), h);
  r11.status === 400
    ? pass('human_in_loop as number → 400')
    : fail('human_in_loop as number → 400', `got ${r11.status}`);

  // Invalid JSON body
  const r12 = await post(config.INGEST_URL, 'not json at all {{{', h);
  r12.status === 400
    ? pass('Invalid JSON body → 400')
    : fail('Invalid JSON body → 400', `got ${r12.status}`);
}

async function testIngestResponse() {
  console.log('\n── Ingest: Response shape and headers ──────────────────────────');

  const h = { 'x-api-key': config.TENANT_KEY };
  const uniqueId = `b1c2d3e4-f5a6-4b7c-8d9e-f0a1b2c3d4e5`;
  const r = await post(config.INGEST_URL, validPayload({ event_id: uniqueId }), h);

  // Status 202
  r.status === 202
    ? pass('Response status is 202')
    : fail('Response status is 202', `got ${r.status}`);

  // Body contains message and event_id
  r.body?.message === 'Accepted'
    ? pass('Response body contains message: Accepted')
    : fail('Response body contains message: Accepted', `got ${JSON.stringify(r.body)}`);

  r.body?.event_id === uniqueId
    ? pass('Response body echoes event_id')
    : fail('Response body echoes event_id', `got ${r.body?.event_id}`);

  // Rate limit headers present
  r.headers.get('x-ratelimit-limit')
    ? pass('X-RateLimit-Limit header present')
    : fail('X-RateLimit-Limit header present', 'header missing');

  r.headers.get('x-ratelimit-remaining')
    ? pass('X-RateLimit-Remaining header present')
    : fail('X-RateLimit-Remaining header present', 'header missing');
}

async function testReadAuth() {
  console.log('\n── Read: Authentication ────────────────────────────────────────');

  // No read key
  const r1 = await get(config.READ_URL);
  r1.status === 401
    ? pass('No read key → 401')
    : fail('No read key → 401', `got ${r1.status}`);

  // Wrong read key
  const r2 = await get(config.READ_URL, { 'x-api-key': 'wrong-read-key' });
  r2.status === 401
    ? pass('Invalid read key → 401')
    : fail('Invalid read key → 401', `got ${r2.status}`);

  // Tenant key used on read endpoint (should also work if it's a read key, but
  // here we test that the correct read key works)
  const r3 = await get(config.READ_URL, { 'x-api-key': config.READ_KEY });
  r3.status === 200
    ? pass('Valid read key → 200')
    : fail('Valid read key → 200', `got ${r3.status} — ${JSON.stringify(r3.body)}`);
}

async function testReadList() {
  console.log('\n── Read: List records ──────────────────────────────────────────');

  const h = { 'x-api-key': config.READ_KEY };

  // Returns 200 with items array
  const r1 = await get(config.READ_URL, h);
  r1.status === 200
    ? pass('List records → 200')
    : fail('List records → 200', `got ${r1.status}`);

  Array.isArray(r1.body?.items)
    ? pass('Response contains items array')
    : fail('Response contains items array', `got ${JSON.stringify(r1.body)}`);

  typeof r1.body?.count === 'number'
    ? pass('Response contains count')
    : fail('Response contains count', `got ${JSON.stringify(r1.body)}`);

  // Date filter — future dates should return empty
  const futureFrom = '2099-01-01T00:00:00Z';
  const futureTo   = '2099-12-31T23:59:59Z';
  const r2 = await get(`${config.READ_URL}?from=${futureFrom}&to=${futureTo}`, h);
  r2.status === 200 && r2.body?.count === 0
    ? pass('Future date filter returns empty results')
    : fail('Future date filter returns empty results', `got status ${r2.status}, count ${r2.body?.count}`);

  // Date filter — past dates around today should return results (at least our test record)
  const from = new Date(Date.now() - 86400000).toISOString(); // yesterday
  const to   = new Date(Date.now() + 86400000).toISOString(); // tomorrow
  const r3 = await get(`${config.READ_URL}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, h);
  r3.status === 200
    ? pass('Date filter with valid range → 200')
    : fail('Date filter with valid range → 200', `got ${r3.status}`);
}

async function testEndToEnd() {
  console.log('\n── End-to-end: Ingest → Read → Tamper check ───────────────────');

  // Use a unique event_id so we can find this specific record
  const { randomUUID } = await import('crypto');
  const eventId = randomUUID();
  const payload = validPayload({
    event_id:      eventId,
    model_version: 'test-model-e2e',
    ai_decision_output: { test: true, score: 99 },
  });

  // Step 1: Send the record
  const ingestRes = await post(config.INGEST_URL, payload, { 'x-api-key': config.TENANT_KEY });
  ingestRes.status === 202
    ? pass('E2E: Record ingested successfully (202)')
    : fail('E2E: Record ingested successfully (202)', `got ${ingestRes.status} — ${JSON.stringify(ingestRes.body)}`);

  if (ingestRes.status !== 202) {
    fail('E2E: Skipping downstream tests — ingest failed');
    return;
  }

  // Step 2: Wait for processor to write to DynamoDB + S3
  console.log('       Waiting 8 seconds for record to be processed...');
  await sleep(8000);

  // Step 3: Find the record in the list
  const listRes = await get(config.READ_URL, { 'x-api-key': config.READ_KEY });
  const found = listRes.body?.items?.find(i => i.event_id === eventId);
  found
    ? pass('E2E: Record appears in list')
    : fail('E2E: Record appears in list', `event_id ${eventId} not found in ${listRes.body?.count} records`);

  if (!found) return;

  // Step 4: Check record fields
  found.model_version === 'test-model-e2e'
    ? pass('E2E: model_version stored correctly')
    : fail('E2E: model_version stored correctly', `got ${found.model_version}`);

  found.human_in_loop === false
    ? pass('E2E: human_in_loop stored correctly')
    : fail('E2E: human_in_loop stored correctly', `got ${found.human_in_loop}`);

  found.ai_decision_output?.score === 99
    ? pass('E2E: ai_decision_output stored correctly')
    : fail('E2E: ai_decision_output stored correctly', `got ${JSON.stringify(found.ai_decision_output)}`);

  // tenant_api_key must NOT be stored
  !found.tenant_api_key
    ? pass('E2E: tenant_api_key stripped from stored record')
    : fail('E2E: tenant_api_key stripped from stored record', 'key is present — security issue');

  // Step 5: Tamper-evidence check
  const base = config.API_BASE_URL.replace(/\/$/, '');
  const historyUrl = `${base}/audit/events/${eventId}/history`;
  const histRes = await get(historyUrl, { 'x-api-key': config.READ_KEY });

  histRes.status === 200
    ? pass('E2E: History endpoint returns 200')
    : fail('E2E: History endpoint returns 200', `got ${histRes.status} — ${JSON.stringify(histRes.body)}`);

  histRes.body?.integrity_verified === true
    ? pass('E2E: Integrity verified — DynamoDB matches S3 archive')
    : fail('E2E: Integrity verified — DynamoDB matches S3 archive',
        `integrity_verified=${histRes.body?.integrity_verified}, note: ${histRes.body?.integrity_note}`);

  histRes.body?.current_record
    ? pass('E2E: current_record present in history response')
    : fail('E2E: current_record present in history response', 'field missing');

  histRes.body?.archived_record
    ? pass('E2E: archived_record present in history response (S3 copy retrieved)')
    : fail('E2E: archived_record present in history response (S3 copy retrieved)',
        `note: ${histRes.body?.integrity_note}`);
}

async function testHistoryEdgeCases() {
  console.log('\n── Read: History edge cases ────────────────────────────────────');

  const h = { 'x-api-key': config.READ_KEY };

  const base = config.API_BASE_URL.replace(/\/$/, '');

  // Non-existent event_id
  const fakeId = 'ffffffff-ffff-4fff-afff-ffffffffffff';
  const r1 = await get(`${base}/audit/events/${fakeId}/history`, h);
  r1.status === 404
    ? pass('History for non-existent event_id → 404')
    : fail('History for non-existent event_id → 404', `got ${r1.status}`);

  // No read key on history endpoint
  const r2 = await get(`${base}/audit/events/${fakeId}/history`);
  r2.status === 401
    ? pass('History with no read key → 401')
    : fail('History with no read key → 401', `got ${r2.status}`);
}

async function testRateLimit() {
  console.log('\n── Ingest: Rate limit headers ──────────────────────────────────');

  const h = { 'x-api-key': config.TENANT_KEY };
  const r = await post(config.INGEST_URL, validPayload(), h);

  const limit     = r.headers.get('x-ratelimit-limit');
  const remaining = r.headers.get('x-ratelimit-remaining');

  limit && parseInt(limit) > 0
    ? pass(`X-RateLimit-Limit is ${limit}`)
    : fail('X-RateLimit-Limit is set and positive', `got ${limit}`);

  remaining !== null && parseInt(remaining) >= 0
    ? pass(`X-RateLimit-Remaining is ${remaining}`)
    : fail('X-RateLimit-Remaining is set and non-negative', `got ${remaining}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  AI Audit Ledger — Test Suite');
  console.log('  Target:', config.API_BASE_URL);
  console.log('═══════════════════════════════════════════════════════════════');

  checkConfig();

  try {
    await testIngestAuth();
    await testIngestValidation();
    await testIngestResponse();
    await testReadAuth();
    await testReadList();
    await testRateLimit();
    await testHistoryEdgeCases();
    await testEndToEnd();
  } catch (err) {
    console.error('\n  UNEXPECTED ERROR:', err.message);
    process.exit(1);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed}/${total} passed`);

  if (failed > 0) {
    console.log(`\n  Failed tests:`);
    failures.forEach(f => {
      console.log(`    ✗  ${f.name}`);
      console.log(`       ${f.reason}`);
    });
    console.log('');
    process.exit(1);
  } else {
    console.log('\n  All tests passed. System is working correctly.');
    console.log('');
  }
}

main();
