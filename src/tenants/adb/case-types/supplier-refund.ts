/**
 * Supplier refund — the case type for the ADB proof of concept.
 *
 * A case opens on a credit note in the Disbursement system and gathers
 * everything that refers to it across Procurement, Disbursement, Treasury, the
 * Cash Room and the document repository. The rules below are ADB's readiness
 * criteria, classification scheme and exception list from the requirement,
 * written as deterministic checks over that evidence. The same evidence always
 * yields the same answer; the language model only narrates.
 *
 * This file is tenant configuration. It knows ADB's record shapes and
 * vocabulary; the platform (src/domain) does not.
 */

import {
  convertToBase,
  firstInRole,
  itemsInRole,
  round2,
  type CaseException,
  type CaseTypeModule,
  type ClassificationAssessment,
  type ClassificationSignal,
  type EvidenceItem,
  type EvidencePackage,
  type FxRateSource,
  type LifecycleAssessment,
  type ReadinessAssessment,
  type ReadinessCheck,
  type SourceReader,
  type StageDefinition,
} from "../../../domain/assessment";
import type { CurrencyCode, DocumentRecord, Money, SourceRecord } from "../../../domain/types";
import { businessDaysBetween } from "../../../lib/business-days";
import type {
  CashRoomReceipt,
  Contract,
  CreditNote,
  FundSource,
  Invoice,
  ProcessingOutcome,
  RefundVoucher,
  TreasuryReceipt,
  TreasuryVoucherStatus,
} from "../records";

export const SUPPLIER_REFUND_ID = "supplier-refund";

export const CLASSIFICATIONS = {
  "cash-room": "Cash Room",
  electronic: "Electronic",
  "trust-fund-refund": "Trust Fund Refund",
  "electronic-transfer-required": "Electronic Transfer Required",
  "currency-purchase-required": "Currency Purchase Required",
} as const;

type Classification = keyof typeof CLASSIFICATIONS;

const STAGES: readonly StageDefinition[] = [
  { id: "credit-note-issued", label: "Credit note issued", staleAfterBusinessDays: 5 },
  { id: "evidence-gathering", label: "Evidence gathering", staleAfterBusinessDays: 5 },
  { id: "awaiting-treasury", label: "Awaiting Treasury confirmation", staleAfterBusinessDays: 5 },
  { id: "ready-for-review", label: "Ready for review", staleAfterBusinessDays: 3 },
  { id: "under-review", label: "Under review", staleAfterBusinessDays: 3 },
  { id: "decided", label: "Decided" },
  { id: "closed", label: "Closed" },
];

/** Cross-currency amounts are compared within this, because rates move between receipt and review. */
const CROSS_CURRENCY_TOLERANCE = 0.03;

// --- a typed view over the evidence -------------------------------------------

interface CaseView {
  readonly creditNote: CreditNote;
  readonly creditNoteDocument?: DocumentRecord;
  readonly invoices: readonly SourceRecord<Invoice>[];
  readonly contract?: Contract;
  readonly fundSources: ReadonlyMap<string, FundSource>;
  /** Funds the two systems say paid the invoice. One entry when they agree. */
  readonly payingFundIds: readonly string[];
  readonly payingFunds: readonly FundSource[];
  readonly fundConflict: boolean;
  readonly voucher?: RefundVoucher;
  readonly treasuryStatus?: TreasuryVoucherStatus;
  /** The Treasury receipt whose reference is this case's voucher. */
  readonly matchedReceipt?: TreasuryReceipt;
  /** Receipts found through the case's documents but quoting another reference. */
  readonly strayReceipts: readonly TreasuryReceipt[];
  readonly cashRoomReceipt?: CashRoomReceipt;
  readonly bankAdvice?: DocumentRecord;
  readonly depositSlip?: DocumentRecord;
  readonly outcomes: readonly ProcessingOutcome[];
  readonly received?: Money;
  readonly receivedInBase?: Money;
  readonly creditInBase?: Money;
}

function view(evidence: EvidencePackage): CaseView {
  const creditNote = evidence.anchor.attributes as CreditNote;
  const invoices = itemsInRole<Invoice>(evidence, "invoice");
  const contract = firstInRole<Contract>(evidence, "contract")?.attributes;
  const fundSources = new Map(
    itemsInRole<FundSource>(evidence, "fund-source").map((r) => [r.attributes.fundSourceId, r.attributes]),
  );
  const payingFundIds = [...new Set(invoices.map((i) => i.attributes.fundSourceId))];
  const payingFunds = payingFundIds.map((id) => fundSources.get(id)).filter((f): f is FundSource => !!f);
  const voucher = firstInRole<RefundVoucher>(evidence, "refund-voucher")?.attributes;
  const receipts = itemsInRole<TreasuryReceipt>(evidence, "treasury-receipt").map((r) => r.attributes);
  const matchedReceipt = voucher ? receipts.find((r) => r.referenceNo === voucher.voucherNo) : undefined;
  const strayReceipts = receipts.filter((r) => r !== matchedReceipt);
  const cashRoomReceipt = firstInRole<CashRoomReceipt>(evidence, "cashroom-receipt")?.attributes;
  const doc = (kind: string) => evidence.documents.find((d) => d.kind === kind);

  const received = matchedReceipt
    ? { amount: matchedReceipt.amountReceived, currency: matchedReceipt.currency }
    : undefined;
  const credit: Money = { amount: creditNote.amount, currency: creditNote.currency };

  return {
    creditNote,
    creditNoteDocument: doc("credit-note"),
    invoices,
    contract,
    fundSources,
    payingFundIds,
    payingFunds,
    fundConflict: payingFundIds.length > 1,
    voucher,
    treasuryStatus: firstInRole<TreasuryVoucherStatus>(evidence, "treasury-voucher-status")?.attributes,
    matchedReceipt,
    strayReceipts,
    cashRoomReceipt,
    bankAdvice: doc("bank-advice"),
    depositSlip: doc("deposit-slip"),
    outcomes: itemsInRole<ProcessingOutcome>(evidence, "processing-outcome").map((r) => r.attributes),
    received,
    receivedInBase: received ? convertToBase(received, evidence.fx) : undefined,
    creditInBase: convertToBase(credit, evidence.fx),
  };
}

function money(m: Money): string {
  return `${m.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} ${m.currency}`;
}

function day(timestamp: string): string {
  return timestamp.slice(0, 10);
}

// --- gather -------------------------------------------------------------------

async function gather(
  anchor: SourceRecord,
  reader: SourceReader,
  fxSource: FxRateSource,
  baseCurrency: CurrencyCode,
  now: Date,
): Promise<EvidencePackage> {
  const creditNote = anchor.attributes as CreditNote;
  const items: EvidenceItem[] = [{ role: "credit-note", record: anchor }];
  const add = (role: string, records: readonly (SourceRecord | undefined)[]) => {
    for (const record of records) if (record) items.push({ role, record });
  };

  // Procurement's copy of the credit note, and both systems' invoice and
  // contract. Two copies of an invoice is the point: they can disagree.
  add(
    "credit-note",
    await reader.byReference("creditNoteNo", creditNote.creditNoteNo, {
      sourceId: "procurement",
      recordType: "credit-note",
    }),
  );
  for (const sourceId of ["procurement", "disbursement"]) {
    add("invoice", [await reader.get(sourceId, "invoice", creditNote.invoiceNo)]);
    add("contract", [await reader.get(sourceId, "contract", creditNote.contractNo)]);
  }

  const gathered = <A extends object>(role: string) =>
    items.filter((item) => item.role === role).map((item) => item.record.attributes as A);
  const fundIds = new Set<string>();
  for (const invoice of gathered<Invoice>("invoice")) fundIds.add(invoice.fundSourceId);
  for (const contract of gathered<Contract>("contract")) {
    for (const id of contract.fundSourceIds) fundIds.add(id);
  }
  for (const id of fundIds) add("fund-source", [await reader.get("procurement", "fund-source", id)]);

  const vouchers = await reader.byReference("creditNoteNo", creditNote.creditNoteNo, {
    sourceId: "disbursement",
    recordType: "refund-voucher",
  });
  add("refund-voucher", vouchers);
  const voucherNo = (vouchers[0]?.attributes as RefundVoucher | undefined)?.voucherNo;

  if (voucherNo) {
    add(
      "treasury-voucher-status",
      await reader.byReference("voucherNo", voucherNo, { sourceId: "treasury", recordType: "refund-voucher" }),
    );
    add(
      "treasury-receipt",
      await reader.byReference("referenceNo", voucherNo, { sourceId: "treasury", recordType: "refund-receipt" }),
    );
    add("cashroom-receipt", await reader.byReference("referenceNo", voucherNo, { sourceId: "cashroom" }));
  }
  add("processing-outcome", await reader.byReference("creditNoteNo", creditNote.creditNoteNo, { recordType: "processing-outcome" }));

  const documents = new Map<string, DocumentRecord>();
  for (const doc of await reader.documentsByReference("creditNoteNo", creditNote.creditNoteNo)) {
    documents.set(doc.documentId, doc);
  }
  if (voucherNo) {
    for (const doc of await reader.documentsByReference("referenceNo", voucherNo)) documents.set(doc.documentId, doc);
  }

  // A bank advice filed against this credit note may quote a reference that
  // is not our voucher. Fetch the receipt it does point at, so a reference
  // mismatch is shown with both sides rather than as "nothing found".
  for (const doc of documents.values()) {
    const ref = doc.references.referenceNo;
    if (doc.kind === "bank-advice" && ref && ref !== voucherNo) {
      add(
        "treasury-receipt",
        await reader.byReference("referenceNo", ref, { sourceId: "treasury", recordType: "refund-receipt" }),
      );
    }
  }

  const currencies = new Set<CurrencyCode>([creditNote.currency]);
  for (const item of items) {
    const attributes = item.record.attributes as { currency?: string };
    if (attributes.currency) currencies.add(attributes.currency);
  }
  const rates = await fxSource.rates(baseCurrency, [...currencies].filter((c) => c !== baseCurrency));

  return {
    organisationId: anchor.organisationId,
    caseTypeId: SUPPLIER_REFUND_ID,
    caseId: creditNote.creditNoteNo,
    anchor,
    items,
    documents: [...documents.values()],
    fx: { base: baseCurrency, rates: Object.fromEntries(rates.map((r) => [r.currency, r])) },
    gatheredAt: now.toISOString(),
  };
}

// --- readiness ----------------------------------------------------------------

function assessReadiness(evidence: EvidencePackage): ReadinessAssessment {
  const v = view(evidence);
  const checks: ReadinessCheck[] = [];

  checks.push(
    v.voucher
      ? {
          id: "voucher-raised",
          label: "Refund voucher raised",
          passed: true,
          detail: `Voucher ${v.voucher.voucherNo} raised on ${day(v.voucher.raisedDate)} (${v.voucher.refundMethod} via ${v.voucher.refundChannel}).`,
          evidence: [v.voucher.voucherNo],
        }
      : {
          id: "voucher-raised",
          label: "Refund voucher raised",
          passed: false,
          detail: `No refund voucher has been raised in Disbursement for credit note ${v.creditNote.creditNoteNo}.`,
          evidence: [],
        },
  );

  if (v.matchedReceipt) {
    checks.push({
      id: "treasury-receipt",
      label: "Treasury receipt references the voucher",
      passed: true,
      detail: `Receipt ${v.matchedReceipt.receiptNo} quotes reference ${v.matchedReceipt.referenceNo}, received ${day(v.matchedReceipt.receivedDate)} via ${v.matchedReceipt.channel}.`,
      evidence: [v.matchedReceipt.receiptNo],
    });
  } else if (v.strayReceipts.length > 0) {
    const stray = v.strayReceipts[0];
    checks.push({
      id: "treasury-receipt",
      label: "Treasury receipt references the voucher",
      passed: false,
      detail: `Receipt ${stray.receiptNo} quotes reference ${stray.referenceNo}, which does not match voucher ${v.voucher?.voucherNo ?? "(none)"}.`,
      evidence: [stray.receiptNo, ...(v.voucher ? [v.voucher.voucherNo] : [])],
    });
  } else {
    checks.push({
      id: "treasury-receipt",
      label: "Treasury receipt references the voucher",
      passed: false,
      detail: v.voucher
        ? `No Treasury receipt references voucher ${v.voucher.voucherNo}.`
        : "No Treasury receipt can be matched without a voucher.",
      evidence: [],
    });
  }

  checks.push({
    id: "treasury-confirmed",
    label: "Treasury confirmation received",
    passed: !!v.matchedReceipt?.confirmed,
    detail: v.matchedReceipt?.confirmed
      ? `Treasury confirmed receipt ${v.matchedReceipt.receiptNo} on ${day(v.matchedReceipt.confirmationDate ?? v.matchedReceipt.receivedDate)}.`
      : v.matchedReceipt
        ? `Receipt ${v.matchedReceipt.receiptNo} is recorded but Treasury has not confirmed it.`
        : "Treasury has not confirmed receipt of the refund.",
    evidence: v.matchedReceipt ? [v.matchedReceipt.receiptNo] : [],
  });

  const cashChannel = v.voucher?.refundChannel === "cash-room";
  if (cashChannel) {
    const ok = !!v.cashRoomReceipt && !!v.depositSlip;
    checks.push({
      id: "deposit-evidence",
      label: "Proof of deposit on file",
      passed: ok,
      detail: ok
        ? `Cash Room deposit ${v.cashRoomReceipt!.depositNo} with deposit slip ${v.depositSlip!.documentId}.`
        : v.cashRoomReceipt
          ? `Cash Room deposit ${v.cashRoomReceipt.depositNo} is recorded but no deposit slip is on file.`
          : "No Cash Room deposit is recorded for this voucher.",
      evidence: [v.cashRoomReceipt?.depositNo, v.depositSlip?.documentId].filter((x): x is string => !!x),
    });
  } else {
    const ok = !!v.bankAdvice;
    checks.push({
      id: "deposit-evidence",
      label: "Proof of deposit on file",
      passed: ok,
      detail: ok
        ? `Bank credit advice ${v.bankAdvice!.documentId} is on file.`
        : v.matchedReceipt
          ? `Treasury receipt ${v.matchedReceipt.receiptNo} is recorded but no bank credit advice is on file for it.`
          : "No refund has been received yet, so there is no bank credit advice to file.",
      evidence: v.bankAdvice ? [v.bankAdvice.documentId] : [],
    });
  }

  checks.push(amountCheck(v, evidence));

  return { verdict: checks.every((c) => c.passed) ? "ready" : "not-ready", checks };
}

function amountCheck(v: CaseView, evidence: EvidencePackage): ReadinessCheck {
  const id = "amount-verified";
  const label = "Amount received matches the credit note";
  const credit: Money = { amount: v.creditNote.amount, currency: v.creditNote.currency };
  if (!v.received || !v.matchedReceipt) {
    return { id, label, passed: false, detail: "No matched receipt to verify the amount against.", evidence: [] };
  }
  const receiptRef = [v.matchedReceipt.receiptNo, v.creditNote.creditNoteNo];

  if (v.received.currency === credit.currency) {
    const diff = round2(v.received.amount - credit.amount);
    return diff === 0
      ? { id, label, passed: true, detail: `Received ${money(v.received)}, equal to the credit note.`, evidence: receiptRef }
      : {
          id,
          label,
          passed: false,
          detail: `Received ${money(v.received)} against a credit note of ${money(credit)} — ${diff < 0 ? "short" : "over"} by ${money({ amount: Math.abs(diff), currency: credit.currency })}.`,
          evidence: receiptRef,
        };
  }

  if (!v.receivedInBase || !v.creditInBase) {
    return {
      id,
      label,
      passed: false,
      detail: `Received ${money(v.received)} against ${money(credit)}; no exchange rate is available to compare them.`,
      evidence: receiptRef,
    };
  }
  const rate = evidence.fx.rates[v.received.currency];
  const ratio = v.receivedInBase.amount / v.creditInBase.amount;
  const within = Math.abs(ratio - 1) <= CROSS_CURRENCY_TOLERANCE;
  return {
    id,
    label,
    passed: within,
    detail: `Received ${money(v.received)} ≈ ${money(v.receivedInBase)} at ${rate ? `1 ${v.received.currency} = ${rate.rateToBase.toFixed(6)} ${evidence.fx.base} (${rate.provider}, ${day(rate.asOf)})` : "an unknown rate"}, against ${money(credit)} ≈ ${money(v.creditInBase)} — ${within ? "within" : "outside"} the ${CROSS_CURRENCY_TOLERANCE * 100}% cross-currency tolerance.`,
    evidence: receiptRef,
  };
}

// --- classification -----------------------------------------------------------

function classify(evidence: EvidencePackage, _readiness: ReadinessAssessment): ClassificationAssessment {
  const v = view(evidence);
  const currencyMismatch =
    (!!v.received && v.received.currency !== v.creditNote.currency) ||
    (!!v.cashRoomReceipt && v.cashRoomReceipt.currency !== v.creditNote.currency);
  const trustFund = v.payingFunds.find((f) => f.type === "trust-fund");

  let classification: Classification;
  let rule: string;
  if (trustFund) {
    classification = "trust-fund-refund";
    rule = `Invoice ${v.creditNote.invoiceNo} was paid from ${trustFund.name}, a trust fund${trustFund.donor ? ` financed by ${trustFund.donor}` : ""}; the refund must return to that fund.`;
  } else if (currencyMismatch) {
    const got = v.received ?? { amount: v.cashRoomReceipt!.amount, currency: v.cashRoomReceipt!.currency };
    classification = "currency-purchase-required";
    rule = `The refund arrived in ${got.currency} against a ${v.creditNote.currency} credit note; a currency purchase is needed to restore the original amount.`;
  } else if (v.voucher?.refundChannel === "cash-room") {
    classification = "cash-room";
    rule = `Voucher ${v.voucher.voucherNo} directs the refund through the Cash Room.`;
  } else if (v.voucher?.refundMethod === "electronic" && !v.matchedReceipt) {
    classification = "electronic-transfer-required";
    rule = `Voucher ${v.voucher.voucherNo} expects an electronic refund and no Treasury receipt references it yet; the supplier still has to transfer the funds.`;
  } else if (v.voucher?.refundMethod === "electronic") {
    classification = "electronic";
    rule = `Voucher ${v.voucher.voucherNo} expects an electronic refund and Treasury receipt ${v.matchedReceipt!.receiptNo} shows it arrived by ${v.matchedReceipt!.channel}.`;
  } else if (v.voucher) {
    classification = "cash-room";
    rule = `Voucher ${v.voucher.voucherNo} specifies a ${v.voucher.refundMethod} refund, which is handled through the Cash Room.`;
  } else {
    classification = "electronic-transfer-required";
    rule = `No refund voucher exists yet; the invoice was paid electronically, so an electronic transfer from the supplier is the expected route.`;
  }

  // Confidence is evidence completeness and consistency, per signal. A signal
  // that does not apply to the chosen classification is left out entirely
  // rather than counted against it.
  const signals: ClassificationSignal[] = [
    {
      id: "fund-source-known",
      label: "Paying fund identified",
      weight: 25,
      satisfied: v.payingFunds.length > 0,
      detail: v.payingFunds.length > 0 ? v.payingFunds.map((f) => f.name).join(" / ") : "No fund source record found for the invoice.",
    },
    {
      id: "fund-sources-agree",
      label: "Procurement and Disbursement agree on the fund",
      weight: 20,
      satisfied: !v.fundConflict,
      detail: v.fundConflict
        ? `Procurement and Disbursement record different funds for invoice ${v.creditNote.invoiceNo}: ${v.payingFundIds.join(" vs ")}.`
        : "Both systems record the same paying fund.",
    },
    {
      id: "refund-method-known",
      label: "Refund method and channel recorded",
      weight: 15,
      satisfied: !!v.voucher,
      detail: v.voucher ? `${v.voucher.refundMethod} via ${v.voucher.refundChannel}` : "No voucher, so the method is inferred.",
    },
    {
      id: "no-unmatched-receipts",
      label: "No receipt filed against this case under another reference",
      weight: 15,
      satisfied: v.strayReceipts.length === 0,
      detail:
        v.strayReceipts.length === 0
          ? "None."
          : `Receipt ${v.strayReceipts[0].receiptNo} quotes ${v.strayReceipts[0].referenceNo}; the money may already be here under the wrong reference.`,
    },
  ];
  if (classification !== "electronic-transfer-required") {
    signals.push(
      {
        id: "receipt-present",
        label: "Treasury receipt matched to the voucher",
        weight: 15,
        satisfied: !!v.matchedReceipt,
        detail: v.matchedReceipt ? `Receipt ${v.matchedReceipt.receiptNo}` : "No matched receipt.",
      },
      {
        id: "treasury-confirmed",
        label: "Treasury confirmation received",
        weight: 15,
        satisfied: !!v.matchedReceipt?.confirmed,
        detail: v.matchedReceipt?.confirmed ? "Confirmed." : "Not confirmed.",
      },
    );
  }
  if (classification !== "currency-purchase-required") {
    signals.push({
      id: "currency-consistent",
      label: "Refund currency matches the credit note",
      weight: 10,
      satisfied: !currencyMismatch,
      detail: currencyMismatch ? "Currencies differ." : `All in ${v.creditNote.currency}.`,
    });
  }

  const total = signals.reduce((sum, s) => sum + s.weight, 0);
  const satisfied = signals.filter((s) => s.satisfied).reduce((sum, s) => sum + s.weight, 0);

  return {
    classification,
    label: CLASSIFICATIONS[classification],
    confidence: Math.round((satisfied / total) * 100),
    rule,
    signals,
  };
}

// --- exceptions ---------------------------------------------------------------

function detectExceptions(
  evidence: EvidencePackage,
  readiness: ReadinessAssessment,
  classification: ClassificationAssessment,
  now: Date,
): CaseException[] {
  const v = view(evidence);
  const out: CaseException[] = [];
  const failed = (id: string) => readiness.checks.find((c) => c.id === id && !c.passed);

  const missingDocs: string[] = [];
  if (!v.creditNoteDocument) missingDocs.push("credit note document");
  const deposit = failed("deposit-evidence");
  // A bank advice can only exist once money has arrived; before that, the
  // outstanding Treasury confirmation is the exception, not a missing document.
  if (deposit && (v.voucher?.refundChannel === "cash-room" || v.matchedReceipt)) {
    missingDocs.push(v.voucher?.refundChannel === "cash-room" ? "deposit slip" : "bank credit advice");
  }
  if (missingDocs.length > 0) {
    out.push({
      id: "missing-documentation",
      severity: "blocking",
      title: "Missing documentation",
      detail: `Not on file: ${missingDocs.join(", ")}.`,
      actionRequired: `Obtain the ${missingDocs.join(" and ")} before processing.`,
      evidence: deposit?.evidence ?? [],
    });
  }

  const receiptCheck = failed("treasury-receipt");
  if (receiptCheck && v.strayReceipts.length > 0) {
    const stray = v.strayReceipts[0];
    out.push({
      id: "reference-mismatch",
      severity: "blocking",
      title: "Reference mismatch",
      detail: receiptCheck.detail,
      actionRequired: `Ask Treasury to confirm whether receipt ${stray.receiptNo} (reference ${stray.referenceNo}) relates to voucher ${v.voucher?.voucherNo ?? "(none)"} and correct the reference before processing.`,
      evidence: receiptCheck.evidence,
    });
  } else if (!v.matchedReceipt?.confirmed) {
    out.push({
      id: "missing-treasury-confirmation",
      severity: "blocking",
      title: "Treasury confirmation outstanding",
      detail: v.matchedReceipt
        ? `Receipt ${v.matchedReceipt.receiptNo} is recorded but not confirmed.`
        : `No Treasury receipt references voucher ${v.voucher?.voucherNo ?? "(none)"}.`,
      actionRequired: "Await Treasury confirmation before processing.",
      evidence: v.matchedReceipt ? [v.matchedReceipt.receiptNo] : [],
    });
  }

  const amount = failed("amount-verified");
  if (amount && v.matchedReceipt) {
    out.push({
      id: "amount-mismatch",
      severity: "blocking",
      title: "Amount not verified",
      detail: amount.detail,
      actionRequired: "Confirm the difference with the supplier and Treasury before processing.",
      evidence: amount.evidence,
    });
  }

  if (v.received && v.received.currency !== v.creditNote.currency) {
    out.push({
      id: "currency-mismatch",
      severity: "warning",
      title: "Currency mismatch",
      detail: `Refund received in ${v.received.currency}; credit note is in ${v.creditNote.currency}.${v.receivedInBase ? ` Received ≈ ${money(v.receivedInBase)}.` : ""}`,
      actionRequired: "Arrange the currency purchase and confirm the converted amount against the credit note.",
      evidence: [v.matchedReceipt!.receiptNo],
    });
  }

  if (v.fundConflict) {
    out.push({
      id: "conflicting-funding-sources",
      severity: "blocking",
      title: "Conflicting funding sources",
      detail: `Procurement and Disbursement record different paying funds for invoice ${v.creditNote.invoiceNo}: ${v.payingFunds.map((f) => f.name).join(" vs ") || v.payingFundIds.join(" vs ")}.`,
      actionRequired: "Resolve which fund paid the invoice with both system owners before processing.",
      evidence: v.invoices.map((i) => `${i.sourceId}/${i.recordId}`),
    });
  } else if ((v.contract?.fundSourceIds.length ?? 0) > 1) {
    out.push({
      id: "multi-funded-contract",
      severity: "info",
      title: "Multi-funded contract",
      detail: `Contract ${v.creditNote.contractNo} draws on ${v.contract!.fundSourceIds.length} funds; the invoice was paid from ${v.payingFunds[0]?.name ?? v.payingFundIds[0]}.`,
      actionRequired: "Confirm the refund is credited to the fund that paid the invoice.",
      evidence: [v.creditNote.contractNo],
    });
  }

  if (classification.classification === "trust-fund-refund") {
    const fund = v.payingFunds.find((f) => f.type === "trust-fund")!;
    out.push({
      id: "trust-fund-routing",
      severity: "info",
      title: "Trust Fund refund",
      detail: `The refund belongs to ${fund.name}${fund.donor ? ` (${fund.donor})` : ""}, not to ordinary resources.`,
      actionRequired: `Route the refund to ${fund.name} and record it against the donor contribution.`,
      evidence: [fund.fundSourceId],
    });
  }

  if (v.voucher && !v.matchedReceipt?.confirmed) {
    const waiting = businessDaysBetween(v.voucher.raisedDate, now);
    const threshold = STAGES.find((s) => s.id === "awaiting-treasury")!.staleAfterBusinessDays!;
    if (waiting > threshold) {
      out.push({
        id: "aging",
        severity: "warning",
        title: "Aging case",
        detail: `Voucher ${v.voucher.voucherNo} has waited ${waiting} business days for a Treasury receipt (threshold ${threshold}).`,
        actionRequired: "Escalate: chase the supplier's remittance and ask Treasury to check for an unmatched receipt.",
        evidence: [v.voucher.voucherNo],
      });
    }
  }

  return out;
}

// --- lifecycle ----------------------------------------------------------------

function lifecycle(
  evidence: EvidencePackage,
  readiness: ReadinessAssessment,
  _exceptions: readonly CaseException[],
  now: Date,
): LifecycleAssessment {
  const v = view(evidence);
  let stageId: string;
  let enteredAt: string;

  if (readiness.verdict === "ready") {
    stageId = "ready-for-review";
    const candidates = [
      v.matchedReceipt?.confirmationDate ?? v.matchedReceipt?.receivedDate,
      ...evidence.documents.map((d) => d.uploadedAt),
    ].filter((x): x is string => !!x);
    enteredAt = candidates.sort().at(-1) ?? evidence.gatheredAt;
  } else if (!v.voucher) {
    stageId = "credit-note-issued";
    enteredAt = v.creditNote.issuedDate;
  } else if (!v.matchedReceipt?.confirmed) {
    stageId = "awaiting-treasury";
    enteredAt = v.voucher.raisedDate;
  } else {
    stageId = "evidence-gathering";
    enteredAt = v.matchedReceipt.confirmationDate ?? v.matchedReceipt.receivedDate;
  }

  const stage = STAGES.find((s) => s.id === stageId)!;
  const businessDaysInStage = businessDaysBetween(enteredAt, now);
  const stale = stage.staleAfterBusinessDays !== undefined && businessDaysInStage > stage.staleAfterBusinessDays;

  return {
    stage: stage.id,
    stageLabel: stage.label,
    enteredAt,
    businessDaysInStage,
    stale,
    escalation: stale
      ? `${businessDaysInStage} business days in "${stage.label}" against a threshold of ${stage.staleAfterBusinessDays}; recommend escalation.`
      : undefined,
  };
}

// --- summary facts --------------------------------------------------------------

function summaryFacts(
  evidence: EvidencePackage,
  readiness: ReadinessAssessment,
  classification: ClassificationAssessment,
  exceptions: readonly CaseException[],
): string[] {
  const v = view(evidence);
  const facts: string[] = [];
  const cn = v.creditNote;

  facts.push(
    `Credit note ${cn.creditNoteNo} for ${money({ amount: cn.amount, currency: cn.currency })} was issued on ${day(cn.issuedDate)} against invoice ${cn.invoiceNo} (contract ${cn.contractNo}) by ${v.contract?.supplierName ?? cn.supplierId}. Reason: ${cn.reason}.`,
  );
  if (v.payingFunds.length === 1) {
    const f = v.payingFunds[0];
    facts.push(`Invoice ${cn.invoiceNo} was paid from ${f.name} (${f.type}${f.donor ? `, financed by ${f.donor}` : ""}).`);
  } else if (v.fundConflict) {
    facts.push(`Procurement and Disbursement disagree on which fund paid invoice ${cn.invoiceNo}: ${v.payingFunds.map((f) => f.name).join(" versus ")}.`);
  }
  if (v.voucher) {
    facts.push(`Refund voucher ${v.voucher.voucherNo} was raised on ${day(v.voucher.raisedDate)} for an ${v.voucher.refundMethod} refund via ${v.voucher.refundChannel}; its status is ${v.voucher.status}.`);
  } else {
    facts.push("No refund voucher has been raised.");
  }
  if (v.matchedReceipt) {
    const r = v.matchedReceipt;
    let line = `Treasury receipt ${r.receiptNo} records ${money(v.received!)} received on ${day(r.receivedDate)} via ${r.channel} against reference ${r.referenceNo}; it is ${r.confirmed ? "confirmed" : "not yet confirmed"}.`;
    if (v.receivedInBase && v.received!.currency !== evidence.fx.base) {
      line += ` That is approximately ${money(v.receivedInBase)} at the rate used for this assessment.`;
    }
    facts.push(line);
  } else if (v.strayReceipts.length > 0) {
    const s = v.strayReceipts[0];
    facts.push(`Treasury receipt ${s.receiptNo} for ${money({ amount: s.amountReceived, currency: s.currency })} is filed against this case but quotes reference ${s.referenceNo}, which does not match the voucher.`);
  } else {
    facts.push("Treasury has no receipt referencing this refund.");
  }
  if (v.cashRoomReceipt) {
    facts.push(`The Cash Room recorded deposit ${v.cashRoomReceipt.depositNo} of ${money({ amount: v.cashRoomReceipt.amount, currency: v.cashRoomReceipt.currency })} on ${day(v.cashRoomReceipt.depositedDate)}.`);
  }
  facts.push(
    evidence.documents.length > 0
      ? `Documents on file: ${evidence.documents.map((d) => `${d.kind} ${d.documentId}`).join(", ")}.`
      : "No supporting documents are on file.",
  );
  const failedChecks = readiness.checks.filter((c) => !c.passed);
  facts.push(
    readiness.verdict === "ready"
      ? "All readiness checks pass."
      : `Not ready. Checks that failed: ${failedChecks.map((c) => c.label).join("; ")}.`,
  );
  facts.push(`Recommended classification: ${classification.label} (${classification.confidence}% confidence). ${classification.rule}`);
  for (const e of exceptions) facts.push(`${e.title}: ${e.detail} Action required: ${e.actionRequired}`);
  return facts;
}

export const supplierRefund: CaseTypeModule = {
  id: SUPPLIER_REFUND_ID,
  name: "Supplier refund",
  anchor: { sourceId: "disbursement", recordType: "credit-note" },
  stages: STAGES,
  classifications: CLASSIFICATIONS,
  gather,
  assessReadiness,
  classify,
  detectExceptions,
  lifecycle,
  summaryFacts,
};
