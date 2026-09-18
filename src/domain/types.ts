/**
 * Generic domain model. Nothing in this file knows about any customer, source
 * system or case type — those are configuration layered on top (see
 * src/tenants and src/case-types).
 */

/** ISO-8601 timestamp, always UTC. */
export type Timestamp = string;

/** ISO-4217 code. */
export type CurrencyCode = string;

export interface Money {
  readonly amount: number;
  readonly currency: CurrencyCode;
}

/**
 * A record as read from a source system through its adaptor.
 *
 * `attributes` is the source's own shape and is deliberately untyped here —
 * each tenant's adaptor narrows it. `references` are the keys that link this
 * record to records elsewhere (an invoice number, a voucher number) and are
 * what evidence gathering traverses. Which references exist, and what they
 * mean, is part of the tenant configuration.
 */
export interface SourceRecord<A extends object = object> {
  readonly organisationId: string;
  /** Interface id, e.g. `procurement`. */
  readonly sourceId: string;
  /** Record type within that source, e.g. `invoice`. */
  readonly recordType: string;
  /** The source's own identifier for the record. */
  readonly recordId: string;
  readonly references: Readonly<Record<string, string>>;
  readonly attributes: A;
  /** When the source last changed this record. */
  readonly updatedAt: Timestamp;
}

/**
 * A document held in the document repository. Bytes live in S3; this is the
 * metadata record that other records reference by `documentId`.
 */
export interface DocumentRecord {
  readonly documentId: string;
  /** Tenant-defined kind, e.g. `deposit-slip`. */
  readonly kind: string;
  readonly title: string;
  readonly contentType: string;
  readonly s3Key: string;
  readonly uploadedAt: Timestamp;
  /** Keys this document supports — the same vocabulary as SourceRecord.references. */
  readonly references: Readonly<Record<string, string>>;
}

/** A source interface an organisation has enabled. */
export interface SourceInterface {
  readonly id: string;
  readonly name: string;
  readonly kind: "standard" | "proprietary";
  readonly recordTypes: readonly string[];
}

export interface Organisation {
  readonly organisationId: string;
  readonly name: string;
  /** Every converted figure a reviewer sees is in this currency. */
  readonly baseCurrency: CurrencyCode;
  readonly interfaces: readonly SourceInterface[];
}
