/**
 * approvalTokens — create and claim single-use restore approval tokens.
 *
 * Tokens are stored in DynamoDB with a 48-hour TTL.
 * Claiming a token atomically transitions it from 'pending' to 'used'
 * via a conditional update — prevents replay attacks.
 */
import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { randomUUID } from 'crypto';

const dynamo = new DynamoDBClient({});

const TOKEN_TTL_SECONDS = 48 * 60 * 60; // 48 hours

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TokenPayload {
  token:        string;
  event_id:     string;
  tenant_id:    string;
  requested_at: string;
}

/** Thrown when a token is not found, already used, or expired. */
export class InvalidTokenError extends Error {
  constructor() {
    super('Token is invalid, already used, or expired');
    this.name = 'InvalidTokenError';
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Store a new single-use pending token and return its string value.
 * The token expires automatically after 48 hours via DynamoDB TTL.
 */
export async function createToken(
  tableName: string,
  eventId:   string,
  tenantId:  string,
): Promise<string> {
  const token    = randomUUID();
  const nowEpoch = Math.floor(Date.now() / 1000);

  await dynamo.send(new PutItemCommand({
    TableName: tableName,
    Item: marshall({
      token,
      event_id:     eventId,
      tenant_id:    tenantId,
      status:       'pending',
      requested_at: new Date().toISOString(),
      ttl:          nowEpoch + TOKEN_TTL_SECONDS,
    }),
  }));

  return token;
}

/**
 * Atomically claim a token by transitioning it from 'pending' to 'used'.
 * Returns the token payload on success.
 * Throws InvalidTokenError if the token is unknown, already used, or expired.
 */
export async function claimToken(
  tableName: string,
  token:     string,
): Promise<TokenPayload> {
  const nowEpoch = Math.floor(Date.now() / 1000);

  try {
    const result = await dynamo.send(new UpdateItemCommand({
      TableName:        tableName,
      Key:              marshall({ token }),
      UpdateExpression: 'SET #status = :used',
      ConditionExpression:
        '#status = :pending AND #ttl > :now',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#ttl':    'ttl',
      },
      ExpressionAttributeValues: marshall({
        ':pending': 'pending',
        ':used':    'used',
        ':now':     nowEpoch,
      }),
      ReturnValues: 'ALL_NEW',
    }));

    return unmarshall(result.Attributes!) as TokenPayload;
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) throw new InvalidTokenError();
    throw e;
  }
}
