/**
 * Unit tests for lib/completeness.ts.
 *
 * Run from infra/cdk:
 *   npx jest lambda/__tests__/completeness.test.ts
 *
 * Covers range resolution, gap detection, hard cap on missing output,
 * and the special cases (empty tenant, empty range, all-present).
 */

import { computeCompleteness, resolveRange } from '../lib/completeness';

describe('resolveRange', () => {
  test('zero counter collapses to (0, 0)', () => {
    expect(resolveRange(0)).toEqual({ from: 0, to: 0 });
  });

  test('defaults span 1..counter when no params', () => {
    expect(resolveRange(10)).toEqual({ from: 1, to: 10 });
  });

  test('clamps `to` to counter even if caller asks for more', () => {
    expect(resolveRange(10, 1, 999)).toEqual({ from: 1, to: 10 });
  });

  test('clamps `from` up to 1', () => {
    expect(resolveRange(10, 0, 5)).toEqual({ from: 1, to: 5 });
  });

  test('floor on fractional inputs', () => {
    expect(resolveRange(10, 1.7, 5.9)).toEqual({ from: 1, to: 5 });
  });

  test('empty range when from > to', () => {
    const r = resolveRange(10, 7, 3);
    expect(r.from).toBeGreaterThan(r.to);
  });
});

describe('computeCompleteness', () => {
  test('empty tenant: nothing to verify', () => {
    const r = computeCompleteness({ presentSequences: [], currentCounter: 0 });
    expect(r.expected_count).toBe(0);
    expect(r.found_count).toBe(0);
    expect(r.missing).toEqual([]);
    expect(r.note).toMatch(/no recorded events/i);
  });

  test('all present in default range', () => {
    const r = computeCompleteness({
      presentSequences: [1, 2, 3, 4, 5],
      currentCounter: 5,
    });
    expect(r.expected_count).toBe(5);
    expect(r.found_count).toBe(5);
    expect(r.missing).toEqual([]);
    expect(r.note).toMatch(/no deletions detected/i);
  });

  test('detects single gap', () => {
    const r = computeCompleteness({
      presentSequences: [1, 2, 4, 5],
      currentCounter: 5,
    });
    expect(r.expected_count).toBe(5);
    expect(r.found_count).toBe(4);
    expect(r.missing).toEqual([3]);
  });

  test('detects multiple gaps in order', () => {
    const r = computeCompleteness({
      presentSequences: [1, 3, 5, 7],
      currentCounter: 7,
    });
    expect(r.missing).toEqual([2, 4, 6]);
  });

  test('respects caller-supplied range', () => {
    const r = computeCompleteness({
      presentSequences: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      currentCounter: 10,
      fromParam: 3,
      toParam: 6,
    });
    expect(r.range).toEqual({ from: 3, to: 6 });
    expect(r.expected_count).toBe(4);
    expect(r.found_count).toBe(4);
    expect(r.missing).toEqual([]);
  });

  test('honours maxMissing truncation', () => {
    const r = computeCompleteness({
      presentSequences: [],
      currentCounter: 50,
      maxMissing: 10,
    });
    expect(r.missing.length).toBe(10);
    expect(r.missing).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(r.note).toMatch(/truncated at 10/);
  });

  test('out-of-range present sequences are ignored', () => {
    const r = computeCompleteness({
      presentSequences: [1, 2, 99],
      currentCounter: 5,
      fromParam: 1,
      toParam: 5,
    });
    expect(r.found_count).toBe(2);
    expect(r.missing).toEqual([3, 4, 5]);
  });

  test('duplicate present sequences are deduplicated', () => {
    const r = computeCompleteness({
      presentSequences: [1, 1, 2, 2, 3, 3],
      currentCounter: 3,
    });
    expect(r.found_count).toBe(3);
    expect(r.missing).toEqual([]);
  });

  test('caller asks for from > to: empty range, clear note', () => {
    const r = computeCompleteness({
      presentSequences: [1, 2, 3],
      currentCounter: 3,
      fromParam: 5,
      toParam: 2,
    });
    expect(r.expected_count).toBe(0);
    expect(r.found_count).toBe(0);
    expect(r.note).toMatch(/Empty range/i);
  });
});
