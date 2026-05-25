/**
 * eventIdGuard — duplicate event_id detection for the ingest path.
 *
 * Scoped per-tenant so cross-tenant ID collisions are not detectable —
 * a tenant cannot probe whether another tenant has used a given event_id.
 */
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';

const dynamo = new DynamoDBClient({});

/**
 * Returns true if an audit record with this event_id already exists
 * for the given tenant.
 */
export async function isDuplicateEventId(
  tableName: string,
  tenantId:  string,
  eventId:   string,
): Promise<boolean> {
  const result = await dynamo.send(new QueryCommand({
    TableName:                 tableName,
    IndexName:                 'event_id-index',
    KeyConditionExpression:    'event_id = :eid',
    FilterExpression:          'tenant_id = :tid',
    ExpressionAttributeValues: {
      ':eid': { S: eventId },
      ':tid': { S: tenantId },
    },
    Limit: 1, // existence check only — no need to fetch more
  }));

  return (result.Count ?? 0) > 0;
}
