/**
 * CloudFormation custom resource that loads the representative data.
 *
 * Runs on stack create and whenever SeedVersion changes, so even the dummy
 * data arrives through CloudFormation rather than a CLI script — the project
 * rule is that nothing in AWS is created any other way. Writes are idempotent
 * (put by key), so re-running is safe. Delete is a no-op: the source tables
 * are destroyed with the stack, and the documents bucket is retained on
 * purpose.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from "aws-lambda";
import { itemsForDocument, itemsForRecord, type KeyedItem } from "../domain/dynamo-keys";
import { buildPdf } from "../lib/mini-pdf";
import { ADB_ORGANISATION } from "../tenants/adb/records";
import { buildAdbSeed } from "../tenants/adb/seed";

interface SeedProperties {
  readonly SeedVersion: string;
  readonly OrganisationId: string;
  readonly CoreTable: string;
  /** sourceId -> table name */
  readonly TableNames: Record<string, string>;
  readonly DocumentsBucket: string;
}

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});

const BATCH = 25;

async function batchWrite(table: string, items: readonly KeyedItem[]): Promise<void> {
  for (let start = 0; start < items.length; start += BATCH) {
    let requests = items
      .slice(start, start + BATCH)
      .map((item) => ({ PutRequest: { Item: item } }));

    // DynamoDB may return part of a batch unprocessed under load; retry those
    // with backoff rather than silently seeding an incomplete dataset.
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt >= 6) throw new Error(`Gave up writing ${requests.length} items to ${table}`);
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      const result = await dynamo.send(new BatchWriteCommand({ RequestItems: { [table]: requests } }));
      requests = (result.UnprocessedItems?.[table] ?? []) as typeof requests;
    }
  }
}

export async function handler(event: CdkCustomResourceEvent): Promise<CdkCustomResourceResponse> {
  const props = event.ResourceProperties as unknown as SeedProperties;
  const physicalResourceId = `reconflow-seed-${props.OrganisationId}`;

  if (event.RequestType === "Delete") {
    return { PhysicalResourceId: physicalResourceId };
  }

  const seed = buildAdbSeed(new Date());
  if (seed.organisationId !== props.OrganisationId) {
    throw new Error(`Seed is for ${seed.organisationId}, stack asked for ${props.OrganisationId}`);
  }

  // Group records by source so each table gets one batched write stream.
  const bySource = new Map<string, KeyedItem[]>();
  for (const record of seed.records) {
    const list = bySource.get(record.sourceId) ?? [];
    list.push(...itemsForRecord(record));
    bySource.set(record.sourceId, list);
  }
  const documentItems: KeyedItem[] = [];
  for (const doc of seed.documents) {
    const { lines: _lines, ...metadata } = doc;
    documentItems.push(...itemsForDocument(seed.organisationId, metadata));
  }
  bySource.set("documents", documentItems);

  for (const [sourceId, items] of bySource) {
    const table = props.TableNames[sourceId];
    if (!table) throw new Error(`No table configured for source "${sourceId}"`);
    await batchWrite(table, items);
  }

  for (const doc of seed.documents) {
    await s3.send(
      new PutObjectCommand({
        Bucket: props.DocumentsBucket,
        Key: doc.s3Key,
        Body: buildPdf(doc.lines),
        ContentType: doc.contentType,
      }),
    );
  }

  // The organisation's own profile lives in the core table.
  await dynamo.send(
    new PutCommand({
      TableName: props.CoreTable,
      Item: {
        PK: `ORG#${ADB_ORGANISATION.organisationId}`,
        SK: "PROFILE",
        ...ADB_ORGANISATION,
        seedVersion: props.SeedVersion,
        seededAt: new Date().toISOString(),
      },
    }),
  );

  const recordCount = [...bySource.values()].reduce((sum, items) => sum + items.length, 0);
  return {
    PhysicalResourceId: physicalResourceId,
    Data: {
      SeedVersion: props.SeedVersion,
      Scenarios: String(seed.scenarios.length),
      Records: String(seed.records.length),
      ItemsWritten: String(recordCount),
      Documents: String(seed.documents.length),
    },
  };
}
