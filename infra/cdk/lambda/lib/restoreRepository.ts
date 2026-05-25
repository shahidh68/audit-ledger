/**
 * restoreRepository — writes an S3 archive copy back to DynamoDB.
 *
 * The S3 Object Lock archive is the trusted source of truth.
 * This module overwrites a tampered or missing DynamoDB record
 * with the sealed S3 copy, restoring integrity.
 */
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const dynamo = new DynamoDBClient({});

/**
 * Overwrite a DynamoDB audit record with the content from the S3 archive.
 * The sort key (sk) is reconstructed from timestamp and event_id since it
 * is never written to S3.
 */
export async function restoreAuditRecord(
  tableName: string,
  s3Record:  Record<string, unknown>,
): Promise<void> {
  const timestamp = String(s3Record.timestamp ?? '');
  const eventId   = String(s3Record.event_id  ?? '');
  const sk        = `${timestamp}#${eventId}`;

  await dynamo.send(new PutItemCommand({
    TableName: tableName,
    Item:      marshall({ ...s3Record, sk }, { removeUndefinedValues: true }),
  }));
}
