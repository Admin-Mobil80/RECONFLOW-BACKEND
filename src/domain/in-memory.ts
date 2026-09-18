import type { FxRate, FxRateSource, SourceReader } from "./assessment";
import type { CurrencyCode, DocumentRecord, SourceRecord } from "./types";

/**
 * SourceReader over arrays. Used by previews and tests so a case type can be
 * run against seed data with no AWS at all — the same code path the DynamoDB
 * reader serves in production.
 */
export class InMemorySourceReader implements SourceReader {
  constructor(
    private readonly records: readonly SourceRecord[],
    private readonly documents: readonly DocumentRecord[],
  ) {}

  async get(sourceId: string, recordType: string, recordId: string): Promise<SourceRecord | undefined> {
    return this.records.find(
      (r) => r.sourceId === sourceId && r.recordType === recordType && r.recordId === recordId,
    );
  }

  async byReference(
    name: string,
    value: string,
    narrow?: { sourceId?: string; recordType?: string },
  ): Promise<SourceRecord[]> {
    return this.records.filter(
      (r) =>
        r.references[name] === value &&
        (!narrow?.sourceId || r.sourceId === narrow.sourceId) &&
        (!narrow?.recordType || r.recordType === narrow.recordType),
    );
  }

  async documentsByReference(name: string, value: string): Promise<DocumentRecord[]> {
    return this.documents.filter((d) => d.references[name] === value);
  }
}

/**
 * Fixed rates, expressed as "1 unit of base buys N units of currency" — the
 * way rates are usually quoted. Converted to rateToBase on the way out.
 */
export class StaticFxRates implements FxRateSource {
  constructor(
    private readonly base: CurrencyCode,
    private readonly perBase: Readonly<Record<CurrencyCode, number>>,
    private readonly asOf: string,
  ) {}

  async rates(base: CurrencyCode, currencies: readonly CurrencyCode[]): Promise<readonly FxRate[]> {
    if (base !== this.base) throw new Error(`Static rates are quoted against ${this.base}, not ${base}`);
    return currencies
      .filter((currency) => currency !== base && this.perBase[currency] !== undefined)
      .map((currency) => ({
        currency,
        rateToBase: 1 / this.perBase[currency],
        asOf: this.asOf,
        provider: "static",
      }));
  }
}
