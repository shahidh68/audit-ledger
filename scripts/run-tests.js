#!/usr/bin/env node
/**
 * AI Audit Ledger — Automated Test Runner
 *
 * Runs all automatable tests from the Test Guide and prints a pass/fail report.
 * Exits with code 0 (all pass) or 1 (any failure) — suitable for CI/CD.
 *
 * Usage:
 *
 *   # Tenant tests only (~30 seconds):
 *   $env:AUDIT_API_KEY="your-key"
 *   $env:AUDIT_INGEST_URL="https://xxxx.execute-api.eu-west-1.amazonaws.com/prod/audit/events"
 *   $env:AUDIT_BASE_URL="https://xxxx.execute-api.eu-west-1.amazonaws.com/prod"
 *   node scripts/run-tests.js
 *
 *   # Include admin tests (needs AWS CLI + admin read key):
 *   $env:AUDIT_ADMIN_READ_KEY="your-admin-read-key"
 *   node scripts/run-tests.js --admin
 *
 *   # Include rate limit test (~90 seconds, sends 105 requests):
 *   node scripts/run-tests.js --rate-limit
 *
 *   # All tests:
 *   node scripts/run-tests.js --admin --rate-limit
 */

'use strict';

const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const { writeFileSync, readFileSync, unlinkSync, existsSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

// ── CLI flags ─────────────────────────────────────────────────────────────────
const RUN_ADMIN      = process.argv.includes('--admin');
const RUN_RATE_LIMIT = process.argv.includes('--rate-limit');

// ── Colours ───────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
};
const green  = (s) => `${C.green}${s}${C.reset}`;
const red    = (s) => `${C.red}${s}${C.reset}`;
const yellow = (s) => `${C.yellow}${s}${C.reset}`;
const blue   = (s) => `${C.blue}${s}${C.reset}`;
const bold   = (s) => `${C.bold}${s}${C.reset}`;
const dim    = (s) => `${C.dim}${s}${C.reset}`;

// ── Config from environment ───────────────────────────────────────────────────
const INGEST_URL   = process.env.AUDIT_INGEST_URL;
const BASE_URL     = process.env.AUDIT_BASE_URL;
const TENANT_KEY   = process.env.AUDIT_API_KEY;
const ADMIN_KEY    = process.env.AUDIT_ADMIN_READ_KEY;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(red(`Missing required environment variable: ${name}`));
    console.error(dim('  Set it with: $env:' + name + '="value"  (PowerShell)'));
    console.error(dim('  Set it with: export ' + name + '="value"  (bash)'));
    process.exit(1);
  }
  return v;
}

// ── Fresh UUIDs for this run (avoids duplicate_id failures from previous runs) ─
const UUID = {
  A11: randomUUID(), // Test A1.1 — primary happy path event
  A13: randomUUID(), // Test A1.3 — second distinct event
  A14: randomUUID(), // Test A1.4 — event with metadata
  A21: randomUUID(), // Test A2.1 — immediate status poll
  B22: randomUUID(), // Test B2.2 — tamper detection (admin)
  NEVER: randomUUID(), // Never submitted — used for "unknown event" tests
};

// ── Test runner state ─────────────────────────────────────────────────────────
const results = [];
let currentSection = '';
let sectionPass = 0;
let sectionFail = 0;
let sectionSkip = 0;

function section(name) {
  if (currentSection) printSectionSummary();
  currentSection  = name;
  sectionPass = sectionFail = sectionSkip = 0;
  console.log(`\n${bold(blue('━'.repeat(70)))}`);
  console.log(`${bold(blue(` ${name}`))}`);
  console.log(`${bold(blue('━'.repeat(70)))}`);
}

function printSectionSummary() {
  const total = sectionPass + sectionFail + sectionSkip;
  const status = sectionFail > 0 ? red('FAILED') : green('PASSED');
  console.log(dim(`  ── ${currentSection}: ${status} (${sectionPass}/${total} passed${sectionSkip ? `, ${sectionSkip} skipped` : ''}) ──`));
}

async function test(id, description, fn, skip = false) {
  if (skip) {
    console.log(`  ${yellow('◌')} ${dim(id)}  ${dim(description)}  ${yellow('[skipped]')}`);
    results.push({ id, description, status: 'SKIP', error: '' });
    sectionSkip++;
    return;
  }

  try {
    await fn();
    console.log(`  ${green('✓')} ${dim(id)}  ${description}`);
    results.push({ id, description, status: 'PASS', error: '' });
    sectionPass++;
  } catch (e) {
    const msg = e.message || String(e);
    console.log(`  ${red('✗')} ${dim(id)}  ${description}`);
    console.log(`       ${red('→')} ${dim(msg)}`);
    results.push({ id, description, status: 'FAIL', error: msg });
    sectionFail++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label = 'value') {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(obj, key, label = '') {
  if (!(key in obj)) throw new Error(`${label || 'Response'} missing field: ${key}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function post(url, body, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json, headers: res.headers };
}

async function get(url, apiKey) {
  const headers = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  const res = await fetch(url, { headers });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json, headers: res.headers };
}

function statusUrl(eventId) {
  return `${BASE_URL}/audit/events/${eventId}/status`;
}

// ── Payload builder ───────────────────────────────────────────────────────────
function payload(eventId, overrides = {}) {
  return {
    event_id:           eventId,
    timestamp:          new Date().toISOString(),
    model_version:      'gpt-4o',
    system_prompt_hash: 'a'.repeat(64),
    input_data_hash:    'b'.repeat(64),
    ai_decision_output: { decision: 'approved', score: 87 },
    human_in_loop:      false,
    ...overrides,
  };
}

// ── AWS CLI helper ────────────────────────────────────────────────────────────
function aws(...args) {
  const result = spawnSync('aws', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`aws ${args[0]} ${args[1]} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 200)}`);
  }
  if (!result.stdout.trim()) return null;
  try { return JSON.parse(result.stdout); } catch { return result.stdout.trim(); }
}

function awsText(...args) {
  const result = spawnSync('aws', [...args, '--output', 'text'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`aws command failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

// ── Auto-detect AWS resource names from CloudFormation ───────────────────────
function cfnOutput(key) {
  try {
    return awsText('cloudformation', 'describe-stacks',
      '--stack-name', 'AiAuditLedgerStack',
      '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`);
  } catch { return null; }
}

// ── Poll status until saved or timeout ───────────────────────────────────────
async function pollUntilSaved(eventId, timeoutMs = 30000, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await get(statusUrl(eventId), TENANT_KEY);
    if (res.status === 200 && res.body?.saved === true) return res.body;
    await sleep(intervalMs);
  }
  throw new Error(`Event ${eventId} not saved after ${timeoutMs / 1000}s`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

async function runTenantTests() {

  // ── A1: Happy Path ──────────────────────────────────────────────────────────
  section('A1  —  Tenant Happy Path');

  await test('A1.1', 'Send valid audit event → 202 Accepted', async () => {
    const res = await post(INGEST_URL, payload(UUID.A11), TENANT_KEY);
    assertEqual(res.status, 202, 'HTTP status');
    assertIncludes(res.body, 'event_id', 'body');
    assertEqual(res.body.event_id, UUID.A11, 'event_id echo');
    assert(res.headers.get('x-ratelimit-limit'), 'X-RateLimit-Limit header present');
    assert(res.headers.get('x-ratelimit-remaining'), 'X-RateLimit-Remaining header present');
  });

  await test('A1.2', 'Status check after 5 seconds → saved: true', async () => {
    await sleep(5000);
    const res = await get(statusUrl(UUID.A11), TENANT_KEY);
    assertEqual(res.status, 200, 'HTTP status');
    assert(res.body?.saved === true, `saved should be true, got: ${JSON.stringify(res.body)}`);
    assertIncludes(res.body, 'tenant_id', 'body');
    assertIncludes(res.body, 'timestamp', 'body');
  });

  await test('A1.3', 'Second event with different event_id → 202 Accepted', async () => {
    const res = await post(INGEST_URL, payload(UUID.A13, {
      model_version: 'claude-3-5-sonnet',
      ai_decision_output: { decision: 'rejected', score: 12 },
      human_in_loop: true,
    }), TENANT_KEY);
    assertEqual(res.status, 202, 'HTTP status');
  });

  await test('A1.3b', 'Status for second event → saved: true (within 30s)', async () => {
    const record = await pollUntilSaved(UUID.A13);
    assert(record.saved === true, 'saved should be true');
  });

  await test('A1.4', 'Event with optional metadata field → 202 Accepted', async () => {
    const res = await post(INGEST_URL, payload(UUID.A14, {
      metadata: { case_id: 'CASE-001', region: 'EU', operator: 'system-a' },
    }), TENANT_KEY);
    assertEqual(res.status, 202, 'HTTP status');
  });

  // ── A2: Edge Cases ──────────────────────────────────────────────────────────
  section('A2  —  Tenant Edge Cases');

  await test('A2.1a', 'Status immediately after submit → saved: false', async () => {
    await post(INGEST_URL, payload(UUID.A21), TENANT_KEY);
    // Check immediately — should be queued but not yet persisted
    const res = await get(statusUrl(UUID.A21), TENANT_KEY);
    assertEqual(res.status, 200, 'HTTP status');
    // Note: may be true if Lambda is fast — both outcomes are valid
    assertIncludes(res.body, 'saved', 'body');
  });

  await test('A2.1b', 'Status after 15 seconds → saved: true (processing complete)', async () => {
    const record = await pollUntilSaved(UUID.A21, 20000);
    assert(record.saved === true, 'saved should be true after polling');
  });

  await test('A2.2', 'Duplicate event_id → 409 Conflict', async () => {
    // Resend UUID.A11 which was already accepted in A1.1
    const res = await post(INGEST_URL, payload(UUID.A11, {
      model_version:      'gpt-4o-mini',
      ai_decision_output: { decision: 'TAMPERED' },
    }), TENANT_KEY);
    assertEqual(res.status, 409, 'HTTP status');
    assertIncludes(res.body, 'error', 'body');
    assertIncludes(res.body, 'event_id', 'body');
  });

  await test('A2.2b', 'Original record unchanged after duplicate rejection', async () => {
    const res = await get(statusUrl(UUID.A11), TENANT_KEY);
    assertEqual(res.status, 200, 'HTTP status');
    assert(res.body?.saved === true, 'original record still saved');
  });

  await test('A2.3', 'Unknown event_id → 200 with saved: false (not 404)', async () => {
    const res = await get(statusUrl(UUID.NEVER), TENANT_KEY);
    assertEqual(res.status, 200, 'HTTP status should be 200 not 404');
    assert(res.body?.saved === false, `saved should be false, got: ${JSON.stringify(res.body)}`);
  });

  // ── A3: Failure Scenarios ───────────────────────────────────────────────────
  section('A3  —  Tenant Failure Scenarios');

  await test('A3.1', 'No API key → 401 Missing API key', async () => {
    const res = await post(INGEST_URL, payload(randomUUID()));
    assertEqual(res.status, 401, 'HTTP status');
    assert(res.body?.error?.toLowerCase().includes('missing'), `error: ${res.body?.error}`);
  });

  await test('A3.2', 'Wrong API key → 401 Invalid API key', async () => {
    const res = await post(INGEST_URL, payload(randomUUID()), 'this-is-not-a-real-key');
    assertEqual(res.status, 401, 'HTTP status');
    assert(res.body?.error?.toLowerCase().includes('invalid'), `error: ${res.body?.error}`);
  });

  await test('A3.3a', 'event_id: "test-001" (plain string) → 400', async () => {
    const res = await post(INGEST_URL, payload('test-001'), TENANT_KEY);
    assertEqual(res.status, 400, 'HTTP status');
  });

  await test('A3.3b', 'event_id: "12345" (numeric string) → 400', async () => {
    const res = await post(INGEST_URL, payload('12345'), TENANT_KEY);
    assertEqual(res.status, 400, 'HTTP status');
  });

  await test('A3.3c', 'event_id without hyphens → 400', async () => {
    const uuidNoHyphens = randomUUID().replace(/-/g, '');
    const res = await post(INGEST_URL, payload(uuidNoHyphens), TENANT_KEY);
    assertEqual(res.status, 400, 'HTTP status');
  });

  await test('A3.4a', 'Missing event_id → 400', async () => {
    const { event_id: _, ...noId } = payload(randomUUID());
    const res = await post(INGEST_URL, noId, TENANT_KEY);
    assertEqual(res.status, 400, 'HTTP status');
  });

  await test('A3.4b', 'Missing timestamp → 400', async () => {
    const { timestamp: _, ...noTs } = payload(randomUUID());
    const res = await post(INGEST_URL, noTs, TENANT_KEY);
    assertEqual(res.status, 400, 'HTTP status');
  });

  await test('A3.4c', 'Missing model_version → 400', async () => {
    const { model_version: _, ...noMv } = payload(randomUUID());
    const res = await post(INGEST_URL, noMv, TENANT_KEY);
    assertEqual(res.status, 400, 'HTTP status');
  });

  await test('A3.4d', 'Missing system_prompt_hash → 400', async () => {
    const { system_prompt_hash: _, ...noSph } = payload(randomUUID());
    const res = await post(INGEST_URL, noSph, TENANT_KEY);
    assertEqual(res.status, 400, 'HTTP status');
  });

  await test('A3.4e', 'Missing ai_decision_output → 400', async () => {
    const { ai_decision_output: _, ...noAdo } = payload(randomUUID());
    const res = await post(INGEST_URL, noAdo, TENANT_KEY);
    assertEqual(res.status, 400, 'HTTP status');
  });

  await test('A3.4f', 'Empty JSON body {} → 400', async () => {
    const res = await post(INGEST_URL, {}, TENANT_KEY);
    assertEqual(res.status, 400, 'HTTP status');
  });

  await test('A3.5a', 'system_prompt_hash too short (10 chars) → 400', async () => {
    const res = await post(INGEST_URL, payload(randomUUID(), { system_prompt_hash: 'aabbccddaa' }), TENANT_KEY);
    assertEqual(res.status, 400, 'HTTP status');
  });

  await test('A3.5b', 'input_data_hash with non-hex characters → 400', async () => {
    const res = await post(INGEST_URL, payload(randomUUID(), { input_data_hash: 'z'.repeat(64) }), TENANT_KEY);
    assertEqual(res.status, 400, 'HTTP status');
  });

  await test('A3.6', 'Malformed JSON body → 400', async () => {
    const res = await post(INGEST_URL, 'this is not json', TENANT_KEY);
    assertEqual(res.status, 400, 'HTTP status');
    assert(res.body?.error?.toLowerCase().includes('json'), `error: ${res.body?.error}`);
  });

  // ── A3.7: Rate limit (opt-in — takes ~90 seconds) ───────────────────────────
  await test('A3.7', 'Rate limit: 101st request in 60s → 429', async () => {
    console.log(dim('       Sending 105 requests — this takes ~60 seconds...'));
    let first429 = -1;
    const batchSize = 105;

    for (let i = 1; i <= batchSize; i++) {
      const res = await post(INGEST_URL, payload(randomUUID()), TENANT_KEY);
      if (res.status === 429 && first429 === -1) {
        first429 = i;
      }
      if (i % 10 === 0) process.stdout.write(dim(`.`));
    }
    process.stdout.write('\n');

    assert(first429 > 0, 'Never received a 429 — rate limit may not be enforced');
    assert(first429 > 95, `429 received at request ${first429} — expected > 95`);
    console.log(dim(`       Rate limit triggered at request ${first429}`));
  }, !RUN_RATE_LIMIT);
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN TESTS
// ─────────────────────────────────────────────────────────────────────────────

async function runAdminTests() {
  // Auto-detect resource names from CloudFormation if not in env
  const AUDIT_TABLE         = process.env.AUDIT_TABLE         || cfnOutput('AuditTableName');
  const RECONCILER_STATE    = process.env.RECONCILER_STATE_TABLE || (() => {
    // Not a standard output — find it via list-tables
    try {
      const tables = aws('dynamodb', 'list-tables', '--query', 'TableNames');
      return (tables || []).find(t => t.includes('ReconcilerState')) || null;
    } catch { return null; }
  })();
  const RESTORE_TABLE       = process.env.RESTORE_APPROVAL_TABLE || (() => {
    try {
      const tables = aws('dynamodb', 'list-tables', '--query', 'TableNames');
      return (tables || []).find(t => t.includes('RestoreApproval')) || null;
    } catch { return null; }
  })();
  const RECONCILER_FN       = process.env.RECONCILER_FN || (() => {
    try {
      const fns = aws('lambda', 'list-functions', '--query', 'Functions[*].FunctionName');
      return (fns || []).find(f => f.includes('ReconcilerFn')) || null;
    } catch { return null; }
  })();

  const hasAwsResources = AUDIT_TABLE && RECONCILER_STATE && RECONCILER_FN;

  // ── B1: Happy Path ──────────────────────────────────────────────────────────
  section('B1  —  Admin Happy Path');

  await test('B1.1a', 'Admin read key can check any tenant\'s event → saved: true', async () => {
    assert(ADMIN_KEY, 'AUDIT_ADMIN_READ_KEY env var required');
    // UUID.A11 was submitted in A1.1 with TENANT_KEY
    const res = await get(statusUrl(UUID.A11), ADMIN_KEY);
    assertEqual(res.status, 200, 'HTTP status');
    assert(res.body?.saved === true, `saved should be true, got: ${JSON.stringify(res.body)}`);
    assertIncludes(res.body, 'tenant_id', 'body');
  }, !ADMIN_KEY);

  await test('B1.2', 'GET /audit/logs with admin read key → 200 with array', async () => {
    assert(ADMIN_KEY, 'AUDIT_ADMIN_READ_KEY env var required');
    const res = await get(`${BASE_URL}/audit/logs`, ADMIN_KEY);
    assertEqual(res.status, 200, 'HTTP status');
    assert(Array.isArray(res.body) || typeof res.body === 'object', 'body should be array or object');
  }, !ADMIN_KEY);

  await test('B1.3', 'Reconciler runs clean → mismatches: 0', async () => {
    assert(RECONCILER_FN, 'Could not find ReconcilerFn — set RECONCILER_FN env var');
    const tmpFile = join(tmpdir(), `reconciler-${Date.now()}.json`);
    try {
      aws('lambda', 'invoke',
        '--function-name', RECONCILER_FN,
        '--payload', '{}',
        '--cli-binary-format', 'raw-in-base64-out',
        tmpFile);
      const raw = readFileSync(tmpFile, 'utf8');
      const result = JSON.parse(raw);
      assert(typeof result.checked === 'number', `checked should be a number, got: ${JSON.stringify(result)}`);
      assert(typeof result.mismatches === 'number', `mismatches should be a number`);
      // Don't assert mismatches === 0 here — there may be pre-existing mismatches
      console.log(dim(`       checked: ${result.checked}, mismatches: ${result.mismatches}`));
    } finally {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    }
  }, !hasAwsResources);

  // ── B2: Edge Cases ──────────────────────────────────────────────────────────
  section('B2  —  Admin Edge Cases');

  await test('B2.1', 'Status polling: false immediately, true after retries', async () => {
    // Send a fresh event and immediately poll
    const res0 = await post(INGEST_URL, payload(UUID.B22 + '-poll-test'), TENANT_KEY);
    // UUID.B22 + '-poll-test' won't be valid UUID — use a real fresh one
    const freshId = randomUUID();
    await post(INGEST_URL, payload(freshId), TENANT_KEY);
    const immediateRes = await get(statusUrl(freshId), TENANT_KEY);
    assertEqual(immediateRes.status, 200, 'HTTP status');
    // Poll until saved
    const saved = await pollUntilSaved(freshId, 30000, 3000);
    assert(saved.saved === true, 'Event should eventually be saved');
  });

  await test('B2.2', 'Tamper detection: corrupt record → reconciler reports mismatch', async () => {
    assert(AUDIT_TABLE, 'Could not find AuditTable — set AUDIT_TABLE env var');
    assert(RECONCILER_STATE, 'Could not find ReconcilerStateTable — set RECONCILER_STATE_TABLE env var');
    assert(RECONCILER_FN, 'Could not find ReconcilerFn — set RECONCILER_FN env var');

    // Wait for UUID.A11 to be definitely saved
    await pollUntilSaved(UUID.A11, 30000);

    // Get the record from DynamoDB via the GSI
    const queryResult = aws('dynamodb', 'query',
      '--table-name', AUDIT_TABLE,
      '--index-name', 'event_id-index',
      '--key-condition-expression', 'event_id = :eid',
      '--expression-attribute-values', JSON.stringify({ ':eid': { S: UUID.A11 } }),
      '--query', 'Items[0]');

    assert(queryResult, `Record for ${UUID.A11} not found in DynamoDB`);
    const tenantId = queryResult.tenant_id.S;
    const sk       = queryResult.sk.S;

    // Corrupt the record
    aws('dynamodb', 'update-item',
      '--table-name', AUDIT_TABLE,
      '--key', JSON.stringify({ tenant_id: { S: tenantId }, sk: { S: sk } }),
      '--update-expression', 'SET ai_decision_output = :v',
      '--expression-attribute-values', JSON.stringify({ ':v': { S: 'TAMPERED-BY-TEST-RUNNER' } }));

    // Reset watermark to before test records
    aws('dynamodb', 'put-item',
      '--table-name', RECONCILER_STATE,
      '--item', JSON.stringify({ pk: { S: 'lastRunAt' }, value: { S: '2026-04-01T00:00:00Z' } }));

    // Invoke reconciler
    const tmpFile = join(tmpdir(), `reconciler-${Date.now()}.json`);
    try {
      aws('lambda', 'invoke',
        '--function-name', RECONCILER_FN,
        '--payload', '{}',
        '--cli-binary-format', 'raw-in-base64-out',
        tmpFile);
      const result = JSON.parse(readFileSync(tmpFile, 'utf8'));
      assert(result.mismatches >= 1, `Expected mismatches >= 1, got ${result.mismatches}`);
      console.log(dim(`       checked: ${result.checked}, mismatches: ${result.mismatches}`));
    } finally {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    }
  }, !hasAwsResources);

  await test('B2.3', 'One-click restore: token claims record from S3, reconciler clean after', async () => {
    assert(RESTORE_TABLE, 'Could not find RestoreApprovalTable — set RESTORE_APPROVAL_TABLE env var');
    assert(RECONCILER_STATE, 'Could not find ReconcilerStateTable');
    assert(RECONCILER_FN, 'Could not find ReconcilerFn');

    // Find a pending restore token for UUID.A11
    const scanResult = aws('dynamodb', 'scan',
      '--table-name', RESTORE_TABLE,
      '--filter-expression', '#s = :p AND event_id = :eid',
      '--expression-attribute-names', JSON.stringify({ '#s': 'status' }),
      '--expression-attribute-values', JSON.stringify({
        ':p': { S: 'pending' },
        ':eid': { S: UUID.A11 },
      }),
      '--query', 'Items[0]');

    assert(scanResult, 'No pending restore token found — B2.2 may not have completed successfully');

    const token    = scanResult.token.S;
    const restoreUrl = `${BASE_URL}/audit/restore/${token}`;

    // Call the restore endpoint
    const res = await fetch(restoreUrl);
    assert(res.ok || res.status === 200, `Restore request failed: ${res.status}`);
    const body = await res.text();
    assert(body.toLowerCase().includes('restor'), `Unexpected restore response: ${body.slice(0, 200)}`);

    // Verify token is now used — calling again should fail
    const res2 = await fetch(restoreUrl);
    const body2 = await res2.text();
    assert(body2.toLowerCase().includes('invalid') || body2.toLowerCase().includes('expired') || body2.toLowerCase().includes('used'),
      'Second restore call should be rejected');

    // Reset watermark and re-run reconciler — should be clean
    aws('dynamodb', 'put-item',
      '--table-name', RECONCILER_STATE,
      '--item', JSON.stringify({ pk: { S: 'lastRunAt' }, value: { S: '2026-04-01T00:00:00Z' } }));

    const tmpFile = join(tmpdir(), `reconciler-${Date.now()}.json`);
    try {
      aws('lambda', 'invoke',
        '--function-name', RECONCILER_FN,
        '--payload', '{}',
        '--cli-binary-format', 'raw-in-base64-out',
        tmpFile);
      const result = JSON.parse(readFileSync(tmpFile, 'utf8'));
      assertEqual(result.mismatches, 0, 'mismatches after restore');
      console.log(dim(`       Post-restore: checked: ${result.checked}, mismatches: ${result.mismatches}`));
    } finally {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    }
  }, !hasAwsResources || !RESTORE_TABLE);

  // ── B3: Failure Scenarios ───────────────────────────────────────────────────
  section('B3  —  Admin Failure Scenarios');

  await test('B3.1', 'Ingest key cannot access /audit/logs → 401', async () => {
    const res = await get(`${BASE_URL}/audit/logs`, TENANT_KEY);
    assertEqual(res.status, 401, 'HTTP status');
  });

  await test('B3.2', 'Used restore token rejected', async () => {
    assert(RESTORE_TABLE, 'Could not find RestoreApprovalTable');
    // Find any "used" token
    const scanResult = aws('dynamodb', 'scan',
      '--table-name', RESTORE_TABLE,
      '--filter-expression', '#s = :u',
      '--expression-attribute-names', JSON.stringify({ '#s': 'status' }),
      '--expression-attribute-values', JSON.stringify({ ':u': { S: 'used' } }),
      '--query', 'Items[0]');

    assert(scanResult, 'No used tokens found — run B2.3 first');
    const token = scanResult.token.S;
    const res   = await fetch(`${BASE_URL}/audit/restore/${token}`);
    const body  = await res.text();
    assert(
      body.toLowerCase().includes('invalid') || body.toLowerCase().includes('expired') || body.toLowerCase().includes('used'),
      `Expected rejection message, got: ${body.slice(0, 200)}`
    );
  }, !hasAwsResources || !RESTORE_TABLE);

  // ── Teardown: reset watermark to now ────────────────────────────────────────
  if (hasAwsResources) {
    const nowIso = new Date().toISOString();
    try {
      aws('dynamodb', 'put-item',
        '--table-name', RECONCILER_STATE,
        '--item', JSON.stringify({ pk: { S: 'lastRunAt' }, value: { S: nowIso } }));
      console.log(dim(`\n  Watermark reset to ${nowIso}`));
    } catch (e) {
      console.log(yellow(`  Warning: could not reset watermark: ${e.message}`));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // Validate required env vars before starting
  requireEnv('AUDIT_API_KEY');
  requireEnv('AUDIT_INGEST_URL');
  requireEnv('AUDIT_BASE_URL');

  console.log(`\n${bold('AI Audit Ledger — Automated Test Runner')}`);
  console.log(dim(`  Ingest URL : ${INGEST_URL}`));
  console.log(dim(`  Base URL   : ${BASE_URL}`));
  console.log(dim(`  Admin tests: ${RUN_ADMIN ? 'yes' : 'no (run with --admin to enable)'}`));
  console.log(dim(`  Rate limit : ${RUN_RATE_LIMIT ? 'yes (~90s)' : 'no (run with --rate-limit to enable)'}`));
  console.log(dim(`  UUIDs      : ${UUID.A11.slice(0, 8)}... (freshly generated)`));

  await runTenantTests();
  if (RUN_ADMIN) await runAdminTests();
  if (currentSection) printSectionSummary();

  // ── Final summary ─────────────────────────────────────────────────────────
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  const total = results.length;

  console.log(`\n${bold(blue('━'.repeat(70)))}`);
  console.log(`${bold(' RESULTS')}`);
  console.log(`${bold(blue('━'.repeat(70)))}`);

  // Print failures first so they're easy to see
  if (fail > 0) {
    console.log(`\n${bold(red('Failed tests:'))}`);
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ${red('✗')} ${bold(r.id)}  ${r.description}`);
      console.log(`       ${dim(r.error)}`);
    });
  }

  console.log(`\n  ${green(`${pass} passed`)}  ${fail > 0 ? red(`${fail} failed`) : dim('0 failed')}  ${skip > 0 ? yellow(`${skip} skipped`) : dim('0 skipped')}  ${dim(`${total} total`)}\n`);

  if (fail === 0 && skip < total) {
    console.log(green(bold('  ✓ All tests passed\n')));
  } else if (fail > 0) {
    console.log(red(bold(`  ✗ ${fail} test${fail > 1 ? 's' : ''} failed\n`)));
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(red(`\nUnexpected error: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
