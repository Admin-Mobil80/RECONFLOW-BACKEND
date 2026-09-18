import type { DocumentRecord, SourceRecord } from "./types";

/**
 * Key layout for the representative source tables (one table per interface).
 *
 *   PK  ORG#<org>                    SK  <recordType>#<recordId>     the record
 *   PK  ORG#<org>#REF#<name>#<value> SK  <recordType>#<recordId>     index item
 *
 * Every reference a record carries gets its own index item, so "find every
 * record that mentions voucher VCH-123" is one Query with no GSI and no
 * knowledge of which record types might reference a voucher. That is what
 * lets evidence gathering stay generic: it walks references, it does not know
 * the schema.
 */

export interface KeyedItem {
  readonly PK: string;
  readonly SK: string;
  readonly [attribute: string]: unknown;
}

export function recordPk(organisationId: string): string {
  return `ORG#${organisationId}`;
}

export function referencePk(organisationId: string, name: string, value: string): string {
  return `ORG#${organisationId}#REF#${name}#${value}`;
}

export function recordSk(recordType: string, recordId: string): string {
  return `${recordType}#${recordId}`;
}

/** The record itself plus one index item per reference. */
export function itemsForRecord(record: SourceRecord): KeyedItem[] {
  const sk = recordSk(record.recordType, record.recordId);
  const base = { ...record, SK: sk };
  const items: KeyedItem[] = [{ ...base, PK: recordPk(record.organisationId) }];
  for (const [name, value] of Object.entries(record.references)) {
    items.push({ ...base, PK: referencePk(record.organisationId, name, value) });
  }
  return items;
}

/** Documents use the same layout so they can be found by reference too. */
export function itemsForDocument(organisationId: string, doc: DocumentRecord): KeyedItem[] {
  const record: SourceRecord<DocumentRecord> = {
    organisationId,
    sourceId: "documents",
    recordType: "document",
    recordId: doc.documentId,
    references: doc.references,
    attributes: doc,
    updatedAt: doc.uploadedAt,
  };
  return itemsForRecord(record);
}
