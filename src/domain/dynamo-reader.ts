import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { SourceReader } from "./assessment";
import { recordPk, recordSk, referencePk } from "./dynamo-keys";
import type { DocumentRecord, SourceRecord } from "./types";

/**
 * SourceReader over the representative source tables, one table per
 * interface. Scoped to a single organisation: every key is prefixed with it,
 * so a reader for one tenant cannot see another's records.
 */
export class DynamoSourceReader implements SourceReader {
  constructor(
    private readonly dynamo: DynamoDBDocumentClient,
    /** sourceId -> table name */
    private readonly tables: Readonly<Record<string, string>>,
    private readonly organisationId: string,
  ) {}

  private toRecord(item: Record<string, unknown>): SourceRecord {
    const { PK: _pk, SK: _sk, ...record } = item;
    return record as unknown as SourceRecord;
  }

  async get(sourceId: string, recordType: string, recordId: string): Promise<SourceRecord | undefined> {
    const table = this.tables[sourceId];
    if (!table) return undefined;
    const result = await this.dynamo.send(
      new GetCommand({
        TableName: table,
        Key: { PK: recordPk(this.organisationId), SK: recordSk(recordType, recordId) },
      }),
    );
    return result.Item ? this.toRecord(result.Item) : undefined;
  }

  async byReference(
    name: string,
    value: string,
    narrow?: { sourceId?: string; recordType?: string },
  ): Promise<SourceRecord[]> {
    const sourceIds = narrow?.sourceId ? [narrow.sourceId] : Object.keys(this.tables);
    const perSource = await Promise.all(
      sourceIds.map(async (sourceId) => {
        const table = this.tables[sourceId];
        if (!table) return [];
        const result = await this.dynamo.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: narrow?.recordType ? "PK = :pk AND begins_with(SK, :sk)" : "PK = :pk",
            ExpressionAttributeValues: {
              ":pk": referencePk(this.organisationId, name, value),
              ...(narrow?.recordType ? { ":sk": `${narrow.recordType}#` } : {}),
            },
          }),
        );
        return (result.Items ?? []).map((item) => this.toRecord(item));
      }),
    );
    // Documents live in their own table but are not "records" to a case type.
    return perSource.flat().filter((record) => record.recordType !== "document");
  }

  async documentsByReference(name: string, value: string): Promise<DocumentRecord[]> {
    const table = this.tables.documents;
    if (!table) return [];
    const result = await this.dynamo.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": referencePk(this.organisationId, name, value) },
      }),
    );
    return (result.Items ?? []).map((item) => this.toRecord(item).attributes as DocumentRecord);
  }

  /** Every record of one type in one source: how a case type finds its anchors. */
  async list(sourceId: string, recordType: string): Promise<SourceRecord[]> {
    const table = this.tables[sourceId];
    if (!table) return [];
    const result = await this.dynamo.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": recordPk(this.organisationId), ":sk": `${recordType}#` },
      }),
    );
    return (result.Items ?? []).map((item) => this.toRecord(item));
  }
}
