import type { APIGatewayProxyResult } from 'aws-lambda';

// Restrict CORS to the configured dashboard origin. Set CORS_ALLOW_ORIGIN in
// each Lambda's environment. Never use '*' — it allows any site to read audit data.
const CORS_ORIGIN = process.env.CORS_ALLOW_ORIGIN ?? '';

/**
 * Build a JSON API Gateway response.
 *
 * @param statusCode    HTTP status code.
 * @param body          Response body — will be JSON-serialised.
 * @param extraHeaders  Optional additional headers (e.g. rate-limit headers).
 */
export function json(
  statusCode: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      // Security headers
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Cache-Control': 'no-store',
      ...(CORS_ORIGIN && { 'Access-Control-Allow-Origin': CORS_ORIGIN }),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}
