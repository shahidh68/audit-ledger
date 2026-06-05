/**
 * Unit tests for sdk/nodejs/src/hashing.mjs.
 *
 * Run from the nodejs SDK root:
 *   node --test tests/hashing.test.mjs
 *
 * Covers:
 *   - HMAC path when AUDIT_HMAC_KEY is set
 *   - Plain SHA-256 fallback when AUDIT_HMAC_KEY is absent
 *   - Backwards compatibility with pre-HMAC hash output
 *   - One-time warning on fallback
 *   - Output shape stability (64-char lowercase hex)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import {
  hashPii,
  hashPrompt,
  _resetFallbackWarnedForTests,
} from '../src/hashing.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

function withEnv(envOverrides, fn) {
  const prev = {};
  for (const key of Object.keys(envOverrides)) {
    prev[key] = process.env[key];
    const v = envOverrides[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(prev)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function captureWarn(fn) {
  const original = console.warn;
  const calls = [];
  console.warn = (...args) => calls.push(args);
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return calls;
}

// ── fallback path ────────────────────────────────────────────────────────────

test('fallback matches plain SHA-256 for back-compat', () => {
  withEnv({ AUDIT_HMAC_KEY: undefined }, () => {
    _resetFallbackWarnedForTests();
    captureWarn(() => {
      const got = hashPii('alice@example.com');
      const expected = createHash('sha256')
        .update('alice@example.com', 'utf8')
        .digest('hex');
      assert.equal(got, expected);
    });
  });
});

test('fallback warns exactly once across multiple calls', () => {
  withEnv({ AUDIT_HMAC_KEY: undefined }, () => {
    _resetFallbackWarnedForTests();
    const warnings = captureWarn(() => {
      hashPii('one');
      hashPii('two');
      hashPrompt('three');
    });
    assert.equal(warnings.length, 1, 'warning should fire only once per process');
    assert.match(warnings[0][0], /AUDIT_HMAC_KEY/);
  });
});

test('empty/whitespace AUDIT_HMAC_KEY treated as unset', () => {
  withEnv({ AUDIT_HMAC_KEY: '   ' }, () => {
    _resetFallbackWarnedForTests();
    captureWarn(() => {
      const got = hashPii('x');
      const expected = createHash('sha256').update('x', 'utf8').digest('hex');
      assert.equal(got, expected);
    });
  });
});

// ── HMAC path ────────────────────────────────────────────────────────────────

test('HMAC path used when key set', () => {
  const key = 'k'.repeat(64);
  withEnv({ AUDIT_HMAC_KEY: key }, () => {
    _resetFallbackWarnedForTests();
    const got = hashPii('alice@example.com');
    const expected = createHmac('sha256', key)
      .update('alice@example.com', 'utf8')
      .digest('hex');
    assert.equal(got, expected);
  });
});

test('HMAC output differs from plain SHA-256 of same input', () => {
  withEnv({ AUDIT_HMAC_KEY: 'secret-key' }, () => {
    _resetFallbackWarnedForTests();
    const keyed = hashPii('alice@example.com');
    const plain = createHash('sha256')
      .update('alice@example.com', 'utf8')
      .digest('hex');
    assert.notEqual(keyed, plain);
  });
});

test('HMAC path does not warn', () => {
  withEnv({ AUDIT_HMAC_KEY: 'secret-key' }, () => {
    _resetFallbackWarnedForTests();
    const warnings = captureWarn(() => {
      hashPii('payload');
    });
    assert.equal(warnings.length, 0);
  });
});

// ── shape ────────────────────────────────────────────────────────────────────

test('output shape stable across both paths (64-char lowercase hex)', () => {
  for (const env of [{ AUDIT_HMAC_KEY: undefined }, { AUDIT_HMAC_KEY: 'abc' }]) {
    withEnv(env, () => {
      _resetFallbackWarnedForTests();
      captureWarn(() => {
        const out = hashPii('payload');
        assert.match(out, /^[0-9a-f]{64}$/);
      });
    });
  }
});

test('hashPrompt is identity-compatible with hashPii on same input', () => {
  withEnv({ AUDIT_HMAC_KEY: 'k' }, () => {
    _resetFallbackWarnedForTests();
    assert.equal(hashPrompt('hello'), hashPii('hello'));
  });
});
