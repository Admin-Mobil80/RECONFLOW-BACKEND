/**
 * Loads the representative data. Two callers:
 *
 *  - CloudFormation, as a custom resource: runs on stack create and whenever
 *    SeedVersion changes, so even dummy data arrives through CloudFormation.
 *    Delete is a no-op - the source tables go with the stack, the documents
 *    bucket is retained on purpose.
 *  - The BMS, invoking the function directly with `{ action: "reset" }`, to put
 *    the demonstration back to its starting point: every record of the
 *    organisation is removed from the source tables (and, if asked, its
 *    decisions), then the seed is loaded afresh.
 *
 * Organisations are never seeded: Riyad creates them from the BMS, and the
 * source data lines up with the one he creates as `adb`.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from "aws-lambda";
import { itemsForDocument, itemsForRecord, type KeyedItem } from "../domain/dynamo-keys";
import { deleteItemsWithPrefix, putItems } from "../domain/dynamo-writer";
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

interface ResetRequest {
  readonly action: "reset";
  readonly clearDecisions?: boolean;
}

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});

async function loadSeed(props: SeedProperties): Promise<{ records: number; items: number; documents: number; scenarios: number }> {
  const seed = buildAdbSeed(new Date());
  if (seed.organisationId !== props.OrganisationId) {
    throw new Error(`Seed is for ${seed.organisationId}, configured for ${props.OrganisationId}`);
  }

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
    await putItems(dynamo, table, items);
  }
  for (const doc of seed.documents) {
    await s3.send(
      new PutObjectCommand({ Bucket: props.DocumentsBucket, Key: doc.s3Key, Body: buildPdf(doc.lines), ContentType: doc.contentType }),
    );
  }

  // Earlier seed versions wrote an organisation profile and listing item;
  // remove them if still present, so the BMS only shows what Riyad created.
  const orgKey = `ORG#${ADB_ORGANISATION.organisationId}`;
  const legacyProfile = await dynamo.send(new GetCommand({ TableName: props.CoreTable, Key: { PK: orgKey, SK: "PROFILE" } }));
  if (legacyProfile.Item?.seedVersion) {
    await dynamo.send(new DeleteCommand({ TableName: props.CoreTable, Key: { PK: orgKey, SK: "PROFILE" } }));
  }
  const legacyListing = await dynamo.send(new GetCommand({ TableName: props.CoreTable, Key: { PK: "ORGANISATIONS", SK: orgKey } }));
  if (String(legacyListing.Item?.ownerEmail ?? "").startsWith("(seeded")) {
    await dynamo.send(new DeleteCommand({ TableName: props.CoreTable, Key: { PK: "ORGANISATIONS", SK: orgKey } }));
  }

  return {
    records: seed.records.length,
    items: [...bySource.values()].reduce((sum, items) => sum + items.length, 0),
    documents: seed.documents.length,
    scenarios: seed.scenarios.length,
  };
}

/** Everything the organisation has in the source tables, gone; decisions too if asked. */
async function clearOrganisation(props: SeedProperties, clearDecisions: boolean): Promise<{ removed: number; decisionsRemoved: number }> {
  let removed = 0;
  for (const table of Object.values(props.TableNames)) {
    removed += await deleteItemsWithPrefix(dynamo, table, `ORG#${props.OrganisationId}`);
  }
  // Decisions live in the core table under CASE#<org>#...; the organisation's
  // profile (ORG#<org>) is left alone - it is Riyad's, not the seed's.
  const decisionsRemoved = clearDecisions
    ? await deleteItemsWithPrefix(dynamo, props.CoreTable, `CASE#${props.OrganisationId}#`)
    : 0;
  return { removed, decisionsRemoved };
}

function propsFromEnvironment(): SeedProperties {
  return {
    SeedVersion: process.env.SEED_VERSION ?? "direct",
    OrganisationId: process.env.ORGANISATION_ID!,
    CoreTable: process.env.CORE_TABLE!,
    TableNames: JSON.parse(process.env.TABLE_NAMES ?? "{}") as Record<string, string>,
    DocumentsBucket: process.env.DOCUMENTS_BUCKET!,
  };
}

export async function handler(event: CdkCustomResourceEvent | ResetRequest): Promise<CdkCustomResourceResponse | Record<string, unknown>> {
  // Direct invocation from the BMS.
  if ("action" in event && event.action === "reset") {
    const props = propsFromEnvironment();
    const cleared = await clearOrganisation(props, event.clearDecisions === true);
    const loaded = await loadSeed(props);
    return { ok: true, ...cleared, ...loaded, at: new Date().toISOString() };
  }

  const cfn = event as CdkCustomResourceEvent;
  const props = cfn.ResourceProperties as unknown as SeedProperties;
  const physicalResourceId = `reconflow-seed-${props.OrganisationId}`;
  if (cfn.RequestType === "Delete") return { PhysicalResourceId: physicalResourceId };

  const loaded = await loadSeed(props);
  return {
    PhysicalResourceId: physicalResourceId,
    Data: {
      SeedVersion: props.SeedVersion,
      Scenarios: String(loaded.scenarios),
      Records: String(loaded.records),
      ItemsWritten: String(loaded.items),
      Documents: String(loaded.documents),
    },
  };
}
