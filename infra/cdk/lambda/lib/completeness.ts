/**
 * Pure completeness logic — no SDK imports, no I/O. Keeps the analysis step
 * unit-testable in isolation from DynamoDB.
 *
 * Given the per-tenant counter value (the upper bound of issued sequence
 * numbers) and the set of sequence numbers actually present in the audit
 * table, return the gaps.
 */

export interface CompletenessRange {
  /** Inclusive lower bound, always >= 1. */
  from: number;
  /** Inclusive upper bound, never above the tenant's current counter. */
  to: number;
}

export interface CompletenessReport {
  range:          CompletenessRange;
  expected_count: number;
  found_count:    number;
  missing:        number[];
  /**
   * Human-readable summary suitable for inclusion in an API response.
   * Distinguishes "no records yet" from "all present" from "gaps detected".
   */
  note: string;
}

export interface CompletenessInput {
  /** Sequence numbers present in the table for this tenant (any order). */
  presentSequences: number[];
  /** Current value of the per-tenant counter; 0 if tenant never wrote. */
  currentCounter: number;
  /** Optional caller-supplied lower bound (clamped to >= 1). */
  fromParam?: number;
  /** Optional caller-supplied upper bound (clamped to currentCounter). */
  toParam?: number;
  /**
   * Hard cap on the number of missing sequence numbers returned in the
   * response so a tenant with a huge gap doesn't blow up the payload.
   * Defaults to 1000.
   */
  maxMissing?: number;
}

const DEFAULT_MAX_MISSING = 1000;

/**
 * Normalise the caller-supplied range against the tenant's counter. Returns
 * a clamped (from, to) pair; either bound may be undefined in the input.
 */
export function resolveRange(
  currentCounter: number,
  fromParam?: number,
  toParam?: number,
): CompletenessRange {
  const counter = Math.max(0, Math.floor(currentCounter));
  if (counter === 0) {
    return { from: 0, to: 0 };
  }
  const from = Math.max(1, Math.floor(fromParam ?? 1));
  const to   = Math.min(counter, Math.floor(toParam ?? counter));
  // If caller's from > to (or > counter), collapse to an empty range cleanly.
  if (from > to) return { from, to: from - 1 };
  return { from, to };
}

/**
 * Compute the report. Pure function so tests can drive it with hand-rolled
 * arrays and assert on the output without any AWS plumbing.
 */
export function computeCompleteness(input: CompletenessInput): CompletenessReport {
  const range = resolveRange(input.currentCounter, input.fromParam, input.toParam);
  const maxMissing = input.maxMissing ?? DEFAULT_MAX_MISSING;

  if (input.currentCounter <= 0) {
    return {
      range,
      expected_count: 0,
      found_count:    0,
      missing:        [],
      note:           'Tenant has no recorded events yet. Nothing to verify.',
    };
  }

  if (range.from > range.to) {
    return {
      range,
      expected_count: 0,
      found_count:    0,
      missing:        [],
      note:           'Empty range: `from` is greater than `to`. Adjust the query parameters.',
    };
  }

  const expected = range.to - range.from + 1;

  // Deduplicate and filter to the requested range in one pass.
  const presentInRange = new Set<number>();
  for (const seq of input.presentSequences) {
    if (seq >= range.from && seq <= range.to) presentInRange.add(seq);
  }
  const found = presentInRange.size;

  const missing: number[] = [];
  for (let n = range.from; n <= range.to; n++) {
    if (!presentInRange.has(n)) {
      missing.push(n);
      if (missing.length >= maxMissing) break;
    }
  }

  const truncated = (expected - found) > missing.length;
  const note = missing.length === 0
    ? 'All sequence numbers in the requested range are present. No deletions detected.'
    : truncated
      ? `Found ${missing.length}+ missing sequence numbers in range. Output truncated at ${maxMissing}; narrow the range to see the rest.`
      : `Found ${missing.length} missing sequence number(s) in range. Each gap represents a deleted, lost, or never-written record. Cross-check against burned_sequence log entries before treating as a deletion.`;

  return {
    range,
    expected_count: expected,
    found_count:    found,
    missing,
    note,
  };
}
