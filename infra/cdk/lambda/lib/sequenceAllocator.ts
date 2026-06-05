/**
 * sequenceAllocator — atomic per-tenant monotonic counter for sequence_no.
 *
 * Used by the processor to assign a sequence number to each successfully
 * stored audit record. The verify-completeness endpoint compares this
 * counter against the rows present in AuditTable to surface omissions.
 *
 * Design notes:
 *   - Counter lives in TenantSequenceTable, partitioned by tenant_id.
 *   - allocateNext is an atomic ADD via DynamoDB UpdateItem, so two parallel
 *     processor invocations for different events of the same tenant cannot
 *     allocate the same number.
 *   - Burn-rate: an allocation followed by a failed audit-row write loses
 *     a sequence number. The processor's pre-flight check on event_id-index
 *     means this happens only on a true SQS redelivery race (visibility
 *     timeout normally serialises retries). Burns are surfaced via a
 *     CloudWatch metric so operators can distinguish from real deletions.
 */

import {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';

const dynamo = new DynamoDBClient({});

/**
 * Atomically increment the per-tenant counter and return the new value.
 *
 * Implementation: `ADD current_sequence :one` on a row keyed by tenant_id.
 * If the row does not yet exist, DynamoDB creates it with current_sequence=1,
 * which is exactly the first sequence number we want.
 *
 * @param tableName name of the TenantSequenceTable (from env)
 * @param tenantId  tenant for whom to allocate
 * @returns the newly allocated sequence number (>= 1)
 */
export async function allocateNextSequence(
  tableName: string,
  tenantId: string,
): Promise<number> {
  const result = await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { tenant_id: { S: tenantId } },
      UpdateExpression: 'ADD current_sequence :one SET updated_at = :now',
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':now': { S: new Date().toISOString() },
      },
      ReturnValues: 'UPDATED_NEW',
    }),
  );

  const raw = result.Attributes?.current_sequence?.N;
  if (!raw) {
    throw new Error(
      `allocateNextSequence: DynamoDB returned no current_sequence for tenant ${tenantId}`,
    );
  }
  const next = Number(raw);
  if (!Number.isInteger(next) || next < 1) {
    throw new Error(
      `allocateNextSequence: invalid current_sequence value "${raw}" for tenant ${tenantId}`,
    );
  }
  return next;
}

/**
 * Read the current counter value for a tenant without incrementing it.
 * Used by the read Lambda when verify-completeness is called without an
 * explicit upper bound. Returns 0 for tenants that have never written.
 */
export async function readCurrentSequence(
  tableName: string,
  tenantId: string,
): Promise<number> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { tenant_id: { S: tenantId } },
      ProjectionExpression: 'current_sequence',
      ConsistentRead: true,
    }),
  );
  const raw = result.Item?.current_sequence?.N;
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}
