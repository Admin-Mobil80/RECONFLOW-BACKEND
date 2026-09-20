import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { KeyedItem } from "./dynamo-keys";

const BATCH = 25;

async function batch(
  dynamo: DynamoDBDocumentClient,
  table: string,
  requests: ({ PutRequest: { Item: KeyedItem } } | { DeleteRequest: { Key: { PK: string; SK: string } } })[],
): Promise<void> {
  for (let start = 0; start < requests.length; start += BATCH) {
    let pending = requests.slice(start, start + BATCH);
    // DynamoDB may return part of a batch unprocessed under load; retry those
    // with backoff rather than silently doing half the work.
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt >= 6) throw new Error(`Gave up on ${pending.length} writes to ${table}`);
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      const result = await dynamo.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }));
      pending = (result.UnprocessedItems?.[table] ?? []) as typeof pending;
    }
  }
}

export async function putItems(dynamo: DynamoDBDocumentClient, table: string, items: readonly KeyedItem[]): Promise<void> {
  await batch(
    dynamo,
    table,
    items.map((item) => ({ PutRequest: { Item: item } })),
  );
}

/**
 * Removes every item whose partition key starts with `pkPrefix` - for a
 * source table, `ORG#<org>` covers the records and their reference-index
 * items alike; for decisions in the core table, `CASE#<org>#`. A Scan,
 * because the reference partitions are not enumerable any other way; fine
 * for representative tables, never for production volumes.
 */
export async function deleteItemsWithPrefix(
  dynamo: DynamoDBDocumentClient,
  table: string,
  pkPrefix: string,
  skPrefix?: string,
): Promise<number> {
  let deleted = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamo.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: skPrefix ? "begins_with(PK, :pk) AND begins_with(SK, :sk)" : "begins_with(PK, :pk)",
        ExpressionAttributeValues: { ":pk": pkPrefix, ...(skPrefix ? { ":sk": skPrefix } : {}) },
        ProjectionExpression: "PK, SK",
        ExclusiveStartKey: startKey,
      }),
    );
    const keys = (page.Items ?? []).map((item) => ({ PK: item.PK as string, SK: item.SK as string }));
    if (keys.length > 0) {
      await batch(
        dynamo,
        table,
        keys.map((Key) => ({ DeleteRequest: { Key } })),
      );
      deleted += keys.length;
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return deleted;
}
