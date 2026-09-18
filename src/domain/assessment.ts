/**
 * The generic assessment model: what every case type produces, and the
 * contract a case type implements to produce it.
 *
 * Deliberately deterministic. Readiness, classification and exceptions are
 * rules over gathered evidence, so the same evidence always yields the same
 * answer — the consistency a control function needs. The language model's job
 * is downstream: narrating the rationale and writing the case summary from
 * `summaryFacts`, never deciding.
 */

import type { CurrencyCode, DocumentRecord, Money, SourceRecord, Timestamp } from "./types";

// --- evidence -----------------------------------------------------------------

/** How a case type reads source systems. Implemented over DynamoDB and, for tests, over memory. */
export interface SourceReader {
  get(sourceId: string, recordType: string, recordId: string): Promise<SourceRecord | undefined>;
  /** Every record carrying reference `name` = `value`, optionally narrowed. */
  byReference(
    name: string,
    value: string,
    narrow?: { sourceId?: string; recordType?: string },
  ): Promise<SourceRecord[]>;
  documentsByReference(name: string, value: string): Promise<DocumentRecord[]>;
}

/** 1 unit of `currency` expressed in the base currency. */
export interface FxRate {
  readonly currency: CurrencyCode;
  readonly rateToBase: number;
  readonly asOf: Timestamp;
  readonly provider: string;
}

export interface FxRateSource {
  /** Rates for each requested currency into `base`. Base itself is always 1. */
  rates(base: CurrencyCode, currencies: readonly CurrencyCode[]): Promise<readonly FxRate[]>;
}

/**
 * Snapshot of the rates an assessment used, kept with the assessment so a
 * reviewer months later sees the same converted figures the recommendation
 * was based on.
 */
export interface FxSnapshot {
  readonly base: CurrencyCode;
  readonly rates: Readonly<Record<CurrencyCode, FxRate>>;
}

export function convertToBase(money: Money, fx: FxSnapshot): Money | undefined {
  if (money.currency === fx.base) return money;
  const rate = fx.rates[money.currency];
  if (!rate) return undefined;
  return { amount: round2(money.amount * rate.rateToBase), currency: fx.base };
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A record's place in the case: the same invoice may appear from two sources. */
export interface EvidenceItem {
  /** Case-type vocabulary, e.g. `invoice`, `treasury-receipt`. */
  readonly role: string;
  readonly record: SourceRecord;
}

export interface EvidencePackage {
  readonly organisationId: string;
  readonly caseTypeId: string;
  /** Stable case identifier, derived from the anchor record. */
  readonly caseId: string;
  readonly anchor: SourceRecord;
  readonly items: readonly EvidenceItem[];
  readonly documents: readonly DocumentRecord[];
  readonly fx: FxSnapshot;
  readonly gatheredAt: Timestamp;
}

/** Records in a role, typed by the case type that asked. */
export function itemsInRole<A extends object>(evidence: EvidencePackage, role: string): SourceRecord<A>[] {
  return evidence.items.filter((item) => item.role === role).map((item) => item.record as SourceRecord<A>);
}

export function firstInRole<A extends object>(evidence: EvidencePackage, role: string): SourceRecord<A> | undefined {
  return itemsInRole<A>(evidence, role)[0];
}

// --- outputs ------------------------------------------------------------------

export interface ReadinessCheck {
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  /** One sentence a reviewer can act on. */
  readonly detail: string;
  /** Record ids or document ids that back this check. */
  readonly evidence: readonly string[];
}

export interface ReadinessAssessment {
  readonly verdict: "ready" | "not-ready";
  readonly checks: readonly ReadinessCheck[];
}

/** One input to the confidence score: present and consistent, or not. */
export interface ClassificationSignal {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
  readonly satisfied: boolean;
  readonly detail: string;
}

export interface ClassificationAssessment {
  /** Case-type vocabulary, e.g. `trust-fund-refund`. */
  readonly classification: string;
  readonly label: string;
  /** 0–100, from the signals below — never from a model's self-assessment. */
  readonly confidence: number;
  /** The rule that fired, in plain words. */
  readonly rule: string;
  readonly signals: readonly ClassificationSignal[];
}

export type ExceptionSeverity = "info" | "warning" | "blocking";

export interface CaseException {
  readonly id: string;
  readonly severity: ExceptionSeverity;
  readonly title: string;
  readonly detail: string;
  /** The explicit "Action Required" the requirement asks for. */
  readonly actionRequired: string;
  readonly evidence: readonly string[];
}

export interface StageDefinition {
  readonly id: string;
  readonly label: string;
  /** Business days in this stage before the case is stale. Absent = never. */
  readonly staleAfterBusinessDays?: number;
}

export interface LifecycleAssessment {
  readonly stage: string;
  readonly stageLabel: string;
  readonly enteredAt: Timestamp;
  readonly businessDaysInStage: number;
  readonly stale: boolean;
  readonly escalation?: string;
}

export interface Assessment {
  readonly organisationId: string;
  readonly caseTypeId: string;
  readonly caseId: string;
  readonly assessedAt: Timestamp;
  readonly readiness: ReadinessAssessment;
  readonly classification: ClassificationAssessment;
  readonly exceptions: readonly CaseException[];
  readonly lifecycle: LifecycleAssessment;
  /** Plain statements of fact for the narrator. No judgement, no prose. */
  readonly summaryFacts: readonly string[];
  readonly fx: FxSnapshot;
}

// --- the contract a case type implements --------------------------------------

export interface CaseTypeModule {
  readonly id: string;
  readonly name: string;
  /** The record that opens a case of this type. */
  readonly anchor: { readonly sourceId: string; readonly recordType: string };
  readonly stages: readonly StageDefinition[];
  readonly classifications: Readonly<Record<string, string>>;

  gather(anchor: SourceRecord, reader: SourceReader, fx: FxRateSource, baseCurrency: CurrencyCode, now: Date): Promise<EvidencePackage>;
  assessReadiness(evidence: EvidencePackage): ReadinessAssessment;
  classify(evidence: EvidencePackage, readiness: ReadinessAssessment): ClassificationAssessment;
  detectExceptions(
    evidence: EvidencePackage,
    readiness: ReadinessAssessment,
    classification: ClassificationAssessment,
    now: Date,
  ): CaseException[];
  lifecycle(evidence: EvidencePackage, readiness: ReadinessAssessment, exceptions: readonly CaseException[], now: Date): LifecycleAssessment;
  summaryFacts(
    evidence: EvidencePackage,
    readiness: ReadinessAssessment,
    classification: ClassificationAssessment,
    exceptions: readonly CaseException[],
  ): string[];
}

/** Runs a case type end to end over one anchor record, keeping the evidence it gathered. */
export async function assessWithEvidence(
  module: CaseTypeModule,
  anchor: SourceRecord,
  reader: SourceReader,
  fx: FxRateSource,
  baseCurrency: CurrencyCode,
  now: Date = new Date(),
): Promise<{ assessment: Assessment; evidence: EvidencePackage }> {
  const evidence = await module.gather(anchor, reader, fx, baseCurrency, now);
  const readiness = module.assessReadiness(evidence);
  const classification = module.classify(evidence, readiness);
  const exceptions = module.detectExceptions(evidence, readiness, classification, now);
  const lifecycle = module.lifecycle(evidence, readiness, exceptions, now);
  const assessment: Assessment = {
    organisationId: evidence.organisationId,
    caseTypeId: module.id,
    caseId: evidence.caseId,
    assessedAt: now.toISOString(),
    readiness,
    classification,
    exceptions,
    lifecycle,
    summaryFacts: module.summaryFacts(evidence, readiness, classification, exceptions),
    fx: evidence.fx,
  };
  return { assessment, evidence };
}

/** Runs a case type end to end over one anchor record. */
export async function assess(
  module: CaseTypeModule,
  anchor: SourceRecord,
  reader: SourceReader,
  fx: FxRateSource,
  baseCurrency: CurrencyCode,
  now: Date = new Date(),
): Promise<Assessment> {
  return (await assessWithEvidence(module, anchor, reader, fx, baseCurrency, now)).assessment;
}
