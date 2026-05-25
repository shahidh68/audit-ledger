/**
 * tenantContacts — DynamoDB read/write helpers for per-tenant notification config.
 *
 * Schema: { tenant_id (PK), email?, webhook_url? }
 *
 * Records are upserted by the admin via PUT /admin/tenants/{tenantId}/contact.
 * All fields except tenant_id are optional — a tenant can have an email, a
 * webhook, or both.
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const dynamo = new DynamoDBClient({});

export interface TenantContact {
  tenant_id:   string;
  email?:      string;
  webhook_url?: string;
}

export async function getTenantContact(
  tableName: string,
  tenantId:  string,
): Promise<TenantContact | null> {
  const result = await dynamo.send(new GetItemCommand({
    TableName: tableName,
    Key: marshall({ tenant_id: tenantId }),
  }));
  return result.Item ? (unmarshall(result.Item) as TenantContact) : null;
}

export async function putTenantContact(
  tableName: string,
  contact:   TenantContact,
): Promise<void> {
  await dynamo.send(new PutItemCommand({
    TableName: tableName,
    Item: marshall(contact, { removeUndefinedValues: true }),
  }));
}

export async function deleteTenantContact(
  tableName: string,
  tenantId:  string,
): Promise<void> {
  await dynamo.send(new DeleteItemCommand({
    TableName: tableName,
    Key: marshall({ tenant_id: tenantId }),
  }));
}

export async function listTenantContacts(
  tableName: string,
): Promise<TenantContact[]> {
  const result = await dynamo.send(new ScanCommand({ TableName: tableName }));
  return (result.Items ?? []).map((i) => unmarshall(i) as TenantContact);
}
