import { UUID4, SHA256, ISO8601, validateIngestionPayload } from '../lib/validation';

// ── UUID4 regex ──────────────────────────────────────────────────────────────

describe('UUID4 regex', () => {
  const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

  it('matches a valid UUID v4 (lowercase)', () => {
    expect(UUID4.test(VALID_UUID)).toBe(true);
  });

  it('matches a valid UUID v4 (uppercase, case insensitive)', () => {
    expect(UUID4.test('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('does not match a non-UUID string', () => {
    expect(UUID4.test('not-a-uuid')).toBe(false);
  });

  it('does not match UUID v1 (version digit 1)', () => {
    expect(UUID4.test('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
  });

  it('does not match UUID v3', () => {
    expect(UUID4.test('550e8400-e29b-31d4-a716-446655440000')).toBe(false);
  });

  it('does not match a short string', () => {
    expect(UUID4.test('550e8400')).toBe(false);
  });

  it('does not match an empty string', () => {
    expect(UUID4.test('')).toBe(false);
  });
});

// ── SHA256 regex ─────────────────────────────────────────────────────────────

describe('SHA256 regex', () => {
  const VALID_SHA = 'a'.repeat(64);

  it('matches 64 lowercase hex chars', () => {
    expect(SHA256.test(VALID_SHA)).toBe(true);
  });

  it('matches 64 uppercase hex chars (case insensitive)', () => {
    expect(SHA256.test('A'.repeat(64))).toBe(true);
  });

  it('does not match 63 hex chars', () => {
    expect(SHA256.test('a'.repeat(63))).toBe(false);
  });

  it('does not match 65 hex chars', () => {
    expect(SHA256.test('a'.repeat(65))).toBe(false);
  });

  it('does not match non-hex characters', () => {
    expect(SHA256.test('z'.repeat(64))).toBe(false);
  });

  it('does not match an empty string', () => {
    expect(SHA256.test('')).toBe(false);
  });
});

// ── ISO8601 regex ─────────────────────────────────────────────────────────────

describe('ISO8601 regex', () => {
  it('matches a valid ISO8601 UTC string', () => {
    expect(ISO8601.test('2026-04-14T10:00:00Z')).toBe(true);
  });

  it('matches a valid ISO8601 string with milliseconds', () => {
    expect(ISO8601.test('2026-04-14T10:00:00.123Z')).toBe(true);
  });

  it('matches a valid ISO8601 string with positive offset', () => {
    expect(ISO8601.test('2026-04-14T10:00:00+01:00')).toBe(true);
  });

  it('matches a valid ISO8601 string with negative offset', () => {
    expect(ISO8601.test('2026-04-14T10:00:00-05:30')).toBe(true);
  });

  it('does not match a bare date', () => {
    expect(ISO8601.test('2026-04-14')).toBe(false);
  });

  it('does not match a datetime with no timezone', () => {
    expect(ISO8601.test('2026-04-14T10:00:00')).toBe(false);
  });

  it('does not match a wrong format', () => {
    expect(ISO8601.test('April 14 2026')).toBe(false);
  });

  it('does not match an empty string', () => {
    expect(ISO8601.test('')).toBe(false);
  });
});

// ── validateIngestionPayload ─────────────────────────────────────────────────

const VALID = {
  event_id: '550e8400-e29b-41d4-a716-446655440000',
  timestamp: '2026-04-14T10:00:00Z',
  model_version: 'gpt-4o',
  system_prompt_hash: 'a'.repeat(64),
  input_data_hash: 'b'.repeat(64),
  ai_decision_output: { decision: 'approved' },
  human_in_loop: false,
};

describe('validateIngestionPayload', () => {
  it('returns null for a valid payload', () => {
    expect(validateIngestionPayload(VALID)).toBeNull();
  });

  it('returns error containing "event_id" when event_id is missing', () => {
    const { event_id, ...rest } = VALID;
    expect(validateIngestionPayload(rest)).toContain('event_id');
  });

  it('returns error containing "event_id" when event_id is a plain non-UUID string', () => {
    expect(validateIngestionPayload({ ...VALID, event_id: 'not-a-uuid' })).toContain('event_id');
  });

  it('returns error containing "timestamp" when timestamp is missing', () => {
    const { timestamp, ...rest } = VALID;
    expect(validateIngestionPayload(rest)).toContain('timestamp');
  });

  it('returns error containing "timestamp" when timestamp has no timezone', () => {
    expect(validateIngestionPayload({ ...VALID, timestamp: '2026-04-14T10:00:00' })).toContain('timestamp');
  });

  it('returns error containing "model_version" when model_version is missing', () => {
    const { model_version, ...rest } = VALID;
    expect(validateIngestionPayload(rest)).toContain('model_version');
  });

  it('returns error containing "model_version" when model_version is empty string', () => {
    expect(validateIngestionPayload({ ...VALID, model_version: '' })).toContain('model_version');
  });

  it('returns error containing "system_prompt_hash" when hash is 63 chars', () => {
    expect(validateIngestionPayload({ ...VALID, system_prompt_hash: 'a'.repeat(63) })).toContain('system_prompt_hash');
  });

  it('returns error containing "input_data_hash" when hash has non-hex chars', () => {
    expect(validateIngestionPayload({ ...VALID, input_data_hash: 'z'.repeat(64) })).toContain('input_data_hash');
  });

  it('returns error containing "ai_decision_output" when value is an array', () => {
    expect(validateIngestionPayload({ ...VALID, ai_decision_output: [] })).toContain('ai_decision_output');
  });

  it('returns error containing "ai_decision_output" when value is null', () => {
    expect(validateIngestionPayload({ ...VALID, ai_decision_output: null })).toContain('ai_decision_output');
  });

  it('returns error containing "ai_decision_output" when value is a string', () => {
    expect(validateIngestionPayload({ ...VALID, ai_decision_output: 'yes' })).toContain('ai_decision_output');
  });

  it('returns error containing "human_in_loop" when value is the string "false"', () => {
    expect(validateIngestionPayload({ ...VALID, human_in_loop: 'false' })).toContain('human_in_loop');
  });

  it('returns error containing "human_in_loop" when value is 0', () => {
    expect(validateIngestionPayload({ ...VALID, human_in_loop: 0 })).toContain('human_in_loop');
  });

  it('ignores extra unknown fields and returns null', () => {
    expect(validateIngestionPayload({ ...VALID, extra_field: 'ignored' })).toBeNull();
  });
});
