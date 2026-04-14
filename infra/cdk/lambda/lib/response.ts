import type { APIGatewayProxyResult } from 'aws-lambda';

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
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}
