// response.ts caches CORS_ORIGIN at module level, so we need to use
// jest.resetModules() and dynamic import() inside each CORS test.

describe('json helper — basic behavior', () => {
  // Import once for non-CORS tests (no env var needed)
  let json: typeof import('../lib/response').json;

  beforeAll(async () => {
    delete process.env.CORS_ALLOW_ORIGIN;
    jest.resetModules();
    ({ json } = await import('../lib/response'));
  });

  it('returns statusCode 200 with correct body and Content-Type', () => {
    const result = json(200, { ok: true });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('{"ok":true}');
    expect(result.headers!['Content-Type']).toBe('application/json');
  });

  it('returns statusCode 400', () => {
    expect(json(400, {}).statusCode).toBe(400);
  });

  it('returns statusCode 500', () => {
    expect(json(500, {}).statusCode).toBe(500);
  });

  it('always includes X-Content-Type-Options: nosniff', () => {
    expect(json(200, {}).headers!['X-Content-Type-Options']).toBe('nosniff');
  });

  it('always includes X-Frame-Options: DENY', () => {
    expect(json(200, {}).headers!['X-Frame-Options']).toBe('DENY');
  });

  it('always includes Strict-Transport-Security starting with max-age=', () => {
    const hsts = json(200, {}).headers!['Strict-Transport-Security'] as string;
    expect(hsts).toBeDefined();
    expect(hsts.startsWith('max-age=')).toBe(true);
  });

  it('always includes Cache-Control: no-store', () => {
    expect(json(200, {}).headers!['Cache-Control']).toBe('no-store');
  });

  it('merges extra headers into the response', () => {
    const result = json(200, {}, { 'X-RateLimit-Remaining': '99' });
    expect(result.headers!['X-RateLimit-Remaining']).toBe('99');
  });
});

describe('CORS header', () => {
  let jsonFn: typeof import('../lib/response').json;

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.CORS_ALLOW_ORIGIN;
  });

  it('includes CORS header when env var is set', async () => {
    process.env.CORS_ALLOW_ORIGIN = 'https://example.com';
    ({ json: jsonFn } = await import('../lib/response'));
    const result = jsonFn(200, {});
    expect(result.headers!['Access-Control-Allow-Origin']).toBe('https://example.com');
  });

  it('omits CORS header when env var is empty string', async () => {
    process.env.CORS_ALLOW_ORIGIN = '';
    ({ json: jsonFn } = await import('../lib/response'));
    const result = jsonFn(200, {});
    expect(result.headers!['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('omits CORS header when env var is not set', async () => {
    delete process.env.CORS_ALLOW_ORIGIN;
    ({ json: jsonFn } = await import('../lib/response'));
    const result = jsonFn(200, {});
    expect(result.headers!['Access-Control-Allow-Origin']).toBeUndefined();
  });
});
