/**
 * Representative data for the ADB proof of concept: ten refund cases that
 * between them exercise the demonstration sequence and every exception the
 * requirement names — missing documentation, Trust Fund refunds, currency
 * mismatches — plus reference and amount mismatches, conflicting funding
 * sources and an aging case.
 *
 * Dates are relative to `now`, so the aging scenario is still aging whenever
 * the data is (re)seeded. Everything is fabricated: suppliers, funds and
 * donors are fictional.
 */

import type { DocumentRecord, SourceRecord, Timestamp } from "../../domain/types";
import {
  ADB_ORGANISATION_ID,
  type AdbDocumentKind,
  type AdbSourceId,
  type CashRoomReceipt,
  type Contract,
  type CreditNote,
  type FundSource,
  type Invoice,
  type ProcessingOutcome,
  type RefundChannel,
  type RefundMethod,
  type RefundVoucher,
  type TreasuryReceipt,
  type TreasuryVoucherStatus,
} from "./records";
import { SUPPLIERS, type Supplier } from "./suppliers";

export interface SeedDocument extends DocumentRecord {
  /** Rendered into the PDF, one line each. ASCII only. */
  readonly lines: readonly string[];
}

export interface ScenarioSummary {
  readonly creditNoteNo: string;
  readonly title: string;
  readonly demonstrates: string;
}

export interface SeedData {
  readonly organisationId: string;
  readonly records: readonly SourceRecord[];
  readonly documents: readonly SeedDocument[];
  readonly scenarios: readonly ScenarioSummary[];
}

// --- fixtures -----------------------------------------------------------------

const FUND_SOURCES: readonly FundSource[] = [
  { fundSourceId: "FS-OCR", name: "Ordinary Capital Resources", type: "ordinary-capital", currency: "USD" },
  { fundSourceId: "FS-TASF", name: "Technical Assistance Special Fund", type: "special-fund", currency: "USD" },
  {
    fundSourceId: "FS-TF-CR",
    name: "Climate Resilience Trust Fund",
    type: "trust-fund",
    currency: "USD",
    donor: "Nordic Climate Partners",
  },
  {
    fundSourceId: "FS-TF-RC",
    name: "Regional Cooperation Trust Fund",
    type: "trust-fund",
    currency: "EUR",
    donor: "European Development Consortium",
  },
];

const bySupplierId = (id: string): Supplier => {
  const found = SUPPLIERS.find((s) => s.supplierId === id);
  if (!found) throw new Error(`Seed refers to unknown supplier ${id}`);
  return found;
};
const SUPPLIERS_BY_KEY: Record<string, Supplier> = {
  meridian: bySupplierId("S-1001"),
  pacific: bySupplierId("S-1002"),
  anand: bySupplierId("S-1003"),
  luzon: bySupplierId("S-1004"),
  mekong: bySupplierId("S-1005"),
  indus: bySupplierId("S-1006"),
};

// --- scenario specification ---------------------------------------------------

interface TreasurySpec {
  readonly confirmed: boolean;
  readonly daysAgo: number;
  readonly channel: TreasuryReceipt["channel"];
  /** Defaults to the credit note amount and currency. */
  readonly amount?: number;
  readonly currency?: string;
  /** Defaults to the voucher number. Set something else to seed a mismatch. */
  readonly referenceNo?: string;
}

interface CaseSpec {
  readonly seq: number;
  readonly title: string;
  readonly demonstrates: string;
  readonly supplier: Supplier;
  readonly contractFunds: readonly string[];
  /** Fund that paid the invoice, as Procurement records it. */
  readonly invoiceFund: string;
  /** As Disbursement records it — differs only in the conflict scenario. */
  readonly disbursementInvoiceFund?: string;
  readonly currency: string;
  readonly invoiceAmount: number;
  readonly creditAmount: number;
  readonly creditDaysAgo: number;
  readonly reason: string;
  readonly voucher: {
    readonly method: RefundMethod;
    readonly channel: RefundChannel;
    readonly daysAgo: number;
    readonly status: RefundVoucher["status"];
  } | null;
  readonly treasury: TreasurySpec | null;
  readonly cashRoom: { readonly amount: number; readonly currency: string; readonly daysAgo: number } | null;
  readonly documents: {
    readonly creditNote?: boolean;
    readonly depositSlip?: boolean;
    readonly bankAdvice?: boolean;
    readonly treasuryConfirmation?: boolean;
  };
  readonly outcome?: { readonly status: ProcessingOutcome["status"]; readonly note: string };
}

const SCENARIOS: readonly CaseSpec[] = [
  {
    seq: 1,
    title: "Electronic refund, complete package",
    demonstrates: "Happy path: ready, classified Electronic with high confidence",
    supplier: SUPPLIERS_BY_KEY.meridian,
    contractFunds: ["FS-OCR"],
    invoiceFund: "FS-OCR",
    currency: "USD",
    invoiceAmount: 48000,
    creditAmount: 7200,
    creditDaysAgo: 9,
    reason: "Deliverable 3 descoped by agreement",
    voucher: { method: "electronic", channel: "bank-transfer", daysAgo: 6, status: "receipted" },
    treasury: { confirmed: true, daysAgo: 2, channel: "wire" },
    cashRoom: null,
    documents: { creditNote: true, bankAdvice: true },
    outcome: { status: "in-progress", note: "Awaiting Control Team review" },
  },
  {
    seq: 2,
    title: "Trust Fund refund, complete package",
    demonstrates: "Trust Fund Refund classification: money must return to the donor-financed fund",
    supplier: SUPPLIERS_BY_KEY.pacific,
    contractFunds: ["FS-TF-CR"],
    invoiceFund: "FS-TF-CR",
    currency: "USD",
    invoiceAmount: 120000,
    creditAmount: 18000,
    creditDaysAgo: 12,
    reason: "Licence count reduced after acceptance testing",
    voucher: { method: "electronic", channel: "bank-transfer", daysAgo: 8, status: "receipted" },
    treasury: { confirmed: true, daysAgo: 3, channel: "wire" },
    cashRoom: null,
    documents: { creditNote: true, bankAdvice: true },
    outcome: { status: "in-progress", note: "Awaiting Control Team review" },
  },
  {
    seq: 3,
    title: "Refund received in a different currency",
    demonstrates: "Currency mismatch: USD invoice, PHP received; Currency Purchase Required",
    supplier: SUPPLIERS_BY_KEY.luzon,
    contractFunds: ["FS-OCR"],
    invoiceFund: "FS-OCR",
    currency: "USD",
    invoiceAmount: 32000,
    creditAmount: 4800,
    creditDaysAgo: 10,
    reason: "Survey area reduced",
    voucher: { method: "electronic", channel: "bank-transfer", daysAgo: 7, status: "receipted" },
    treasury: { confirmed: true, daysAgo: 2, channel: "wire", amount: 268800, currency: "PHP" },
    cashRoom: null,
    documents: { creditNote: true, bankAdvice: true },
  },
  {
    seq: 4,
    title: "Cash deposit without proof",
    demonstrates: "Missing documentation: no deposit slip, so not ready",
    supplier: SUPPLIERS_BY_KEY.anand,
    contractFunds: ["FS-TASF"],
    invoiceFund: "FS-TASF",
    currency: "USD",
    invoiceAmount: 15000,
    creditAmount: 2250,
    creditDaysAgo: 8,
    reason: "Duplicate billing of workshop costs",
    voucher: { method: "cash", channel: "cash-room", daysAgo: 5, status: "receipted" },
    treasury: { confirmed: true, daysAgo: 1, channel: "cash-room" },
    cashRoom: { amount: 2250, currency: "USD", daysAgo: 3 },
    documents: { creditNote: true },
  },
  {
    seq: 5,
    title: "Electronic refund not yet received",
    demonstrates: "Awaiting Treasury confirmation; Electronic Transfer Required from the supplier",
    supplier: SUPPLIERS_BY_KEY.mekong,
    contractFunds: ["FS-OCR"],
    invoiceFund: "FS-OCR",
    currency: "USD",
    invoiceAmount: 60000,
    creditAmount: 9000,
    creditDaysAgo: 5,
    reason: "Freight surcharge withdrawn",
    voucher: { method: "electronic", channel: "bank-transfer", daysAgo: 3, status: "awaiting-receipt" },
    treasury: null,
    cashRoom: null,
    documents: { creditNote: true },
  },
  {
    seq: 6,
    title: "Treasury receipt quotes the wrong reference",
    demonstrates: "Reference mismatch: receipt exists but cannot be tied to the voucher",
    supplier: SUPPLIERS_BY_KEY.meridian,
    contractFunds: ["FS-OCR"],
    invoiceFund: "FS-OCR",
    currency: "USD",
    invoiceAmount: 25000,
    creditAmount: 3750,
    creditDaysAgo: 11,
    reason: "Rate correction for senior consultant days",
    voucher: { method: "electronic", channel: "bank-transfer", daysAgo: 8, status: "awaiting-receipt" },
    treasury: { confirmed: true, daysAgo: 2, channel: "wire", referenceNo: "VCH-2026-0160" },
    cashRoom: null,
    documents: { creditNote: true, bankAdvice: true },
  },
  {
    seq: 7,
    title: "Cash Room refund, complete package",
    demonstrates: "Cash Room classification with deposit slip and Treasury confirmation",
    supplier: SUPPLIERS_BY_KEY.anand,
    contractFunds: ["FS-TASF"],
    invoiceFund: "FS-TASF",
    currency: "USD",
    invoiceAmount: 8000,
    creditAmount: 1200,
    creditDaysAgo: 7,
    reason: "Unused per diem returned",
    voucher: { method: "cash", channel: "cash-room", daysAgo: 5, status: "receipted" },
    treasury: { confirmed: true, daysAgo: 1, channel: "cash-room" },
    cashRoom: { amount: 1200, currency: "USD", daysAgo: 2 },
    documents: { creditNote: true, depositSlip: true, treasuryConfirmation: true },
    outcome: { status: "in-progress", note: "Awaiting Control Team review" },
  },
  {
    seq: 8,
    title: "Multi-funded contract with conflicting funding records",
    demonstrates: "Complex scenario: Procurement and Disbursement disagree on which fund paid",
    supplier: SUPPLIERS_BY_KEY.indus,
    contractFunds: ["FS-OCR", "FS-TF-RC"],
    invoiceFund: "FS-OCR",
    disbursementInvoiceFund: "FS-TF-RC",
    currency: "EUR",
    invoiceAmount: 40000,
    creditAmount: 6000,
    creditDaysAgo: 9,
    reason: "Laboratory analysis not performed",
    voucher: { method: "electronic", channel: "bank-transfer", daysAgo: 6, status: "receipted" },
    treasury: { confirmed: true, daysAgo: 2, channel: "wire" },
    cashRoom: null,
    documents: { creditNote: true, bankAdvice: true },
  },
  {
    seq: 9,
    title: "No Treasury receipt after two weeks",
    demonstrates: "Aging case: stale while awaiting Treasury, escalation recommended",
    supplier: SUPPLIERS_BY_KEY.pacific,
    contractFunds: ["FS-OCR"],
    invoiceFund: "FS-OCR",
    currency: "USD",
    invoiceAmount: 22000,
    creditAmount: 3300,
    creditDaysAgo: 17,
    reason: "Support hours over-billed",
    voucher: { method: "electronic", channel: "bank-transfer", daysAgo: 14, status: "awaiting-receipt" },
    treasury: null,
    cashRoom: null,
    documents: { creditNote: true },
    outcome: { status: "on-hold", note: "Supplier reminded on day 10" },
  },
  {
    seq: 10,
    title: "Amount received differs from credit note",
    demonstrates: "Amount not verified: Treasury received less than the credit note value",
    supplier: SUPPLIERS_BY_KEY.mekong,
    contractFunds: ["FS-TASF"],
    invoiceFund: "FS-TASF",
    currency: "USD",
    invoiceAmount: 30000,
    creditAmount: 4500,
    creditDaysAgo: 10,
    reason: "Partial cancellation of training module",
    voucher: { method: "electronic", channel: "bank-transfer", daysAgo: 7, status: "receipted" },
    treasury: { confirmed: true, daysAgo: 2, channel: "wire", amount: 4050 },
    cashRoom: null,
    documents: { creditNote: true, bankAdvice: true },
  },
];

// --- generation ---------------------------------------------------------------

function daysAgo(now: Date, days: number): Timestamp {
  const date = new Date(now.getTime() - days * 86_400_000);
  return date.toISOString();
}

function pad(seq: number): string {
  return String(seq).padStart(4, "0");
}

function dateOnly(timestamp: Timestamp): string {
  return timestamp.slice(0, 10);
}

function record<A extends object>(
  sourceId: AdbSourceId,
  recordType: string,
  recordId: string,
  references: Record<string, string>,
  attributes: A,
  updatedAt: Timestamp,
): SourceRecord<A> {
  return {
    organisationId: ADB_ORGANISATION_ID,
    sourceId,
    recordType,
    recordId,
    references,
    attributes,
    updatedAt,
  };
}

function document(
  seq: number,
  kind: AdbDocumentKind,
  title: string,
  references: Record<string, string>,
  uploadedAt: Timestamp,
  lines: readonly string[],
): SeedDocument {
  const documentId = `DOC-${pad(seq)}-${kind}`;
  return {
    documentId,
    kind,
    title,
    contentType: "application/pdf",
    s3Key: `${ADB_ORGANISATION_ID}/${documentId}.pdf`,
    uploadedAt,
    references: { ...references, documentId },
    lines,
  };
}

function money(amount: number, currency: string): string {
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} ${currency}`;
}

function buildCase(spec: CaseSpec, now: Date): { records: SourceRecord[]; documents: SeedDocument[] } {
  const records: SourceRecord[] = [];
  const documents: SeedDocument[] = [];
  const n = pad(spec.seq);
  const contractNo = `CTR-2025-${n}`;
  const invoiceNo = `INV-2026-${n}`;
  const creditNoteNo = `CN-2026-${n}`;
  const voucherNo = `VCH-2026-${n}`;
  const { supplierId, supplierName } = spec.supplier;

  const creditIssued = daysAgo(now, spec.creditDaysAgo);
  const contractSigned = daysAgo(now, spec.creditDaysAgo + 120);
  const invoicePaid = daysAgo(now, spec.creditDaysAgo + 30);

  const contract: Contract = {
    contractNo,
    supplierId,
    supplierName,
    title: `TA services - ${supplierName}`,
    currency: spec.currency,
    totalAmount: spec.invoiceAmount * 4,
    fundSourceIds: spec.contractFunds,
    signedDate: contractSigned,
  };
  const contractRefs = { contractNo, supplierId };

  const invoiceFor = (fundSourceId: string): Invoice => ({
    invoiceNo,
    contractNo,
    supplierId,
    amount: spec.invoiceAmount,
    currency: spec.currency,
    fundSourceId,
    status: "paid",
    paidDate: invoicePaid,
    paidVia: "electronic",
  });

  const creditNoteDoc = spec.documents.creditNote
    ? document(
        spec.seq,
        "credit-note",
        `Credit note ${creditNoteNo}`,
        { creditNoteNo, invoiceNo, supplierId },
        creditIssued,
        [
          "CREDIT NOTE",
          "",
          `Credit note no: ${creditNoteNo}`,
          `Against invoice: ${invoiceNo}`,
          `Contract: ${contractNo}`,
          `Supplier: ${supplierName} (${supplierId})`,
          `Amount: ${money(spec.creditAmount, spec.currency)}`,
          `Reason: ${spec.reason}`,
          `Issued: ${dateOnly(creditIssued)}`,
        ],
      )
    : undefined;
  if (creditNoteDoc) documents.push(creditNoteDoc);

  const creditNote: CreditNote = {
    creditNoteNo,
    invoiceNo,
    contractNo,
    supplierId,
    amount: spec.creditAmount,
    currency: spec.currency,
    issuedDate: creditIssued,
    reason: spec.reason,
    documentId: creditNoteDoc?.documentId,
  };
  const creditRefs = {
    creditNoteNo,
    invoiceNo,
    contractNo,
    supplierId,
    ...(creditNoteDoc ? { documentId: creditNoteDoc.documentId } : {}),
  };

  // Procurement and Disbursement both hold the contract, invoice and credit
  // note. Normally they agree; the conflict scenario makes them disagree on
  // which fund paid the invoice.
  for (const sourceId of ["procurement", "disbursement"] as const) {
    const fund =
      sourceId === "disbursement" && spec.disbursementInvoiceFund
        ? spec.disbursementInvoiceFund
        : spec.invoiceFund;
    records.push(record(sourceId, "contract", contractNo, contractRefs, contract, contractSigned));
    records.push(
      record(
        sourceId,
        "invoice",
        invoiceNo,
        { invoiceNo, contractNo, supplierId, fundSourceId: fund },
        invoiceFor(fund),
        invoicePaid,
      ),
    );
    records.push(record(sourceId, "credit-note", creditNoteNo, creditRefs, creditNote, creditIssued));
  }

  if (spec.voucher) {
    const raised = daysAgo(now, spec.voucher.daysAgo);
    const voucher: RefundVoucher = {
      voucherNo,
      creditNoteNo,
      invoiceNo,
      amount: spec.creditAmount,
      currency: spec.currency,
      refundMethod: spec.voucher.method,
      refundChannel: spec.voucher.channel,
      raisedDate: raised,
      status: spec.voucher.status,
    };
    records.push(
      record("disbursement", "refund-voucher", voucherNo, { voucherNo, creditNoteNo, invoiceNo }, voucher, raised),
    );

    // Treasury's partial view of the same voucher.
    const treasuryStatus: TreasuryVoucherStatus = {
      voucherNo,
      treasuryStatus: !spec.treasury ? "not-received" : spec.treasury.confirmed ? "confirmed" : "received",
      updatedDate: spec.treasury ? daysAgo(now, spec.treasury.daysAgo) : raised,
    };
    records.push(
      record("treasury", "refund-voucher", voucherNo, { voucherNo, creditNoteNo }, treasuryStatus, treasuryStatus.updatedDate),
    );
  }

  if (spec.treasury) {
    const received = daysAgo(now, spec.treasury.daysAgo);
    const amount = spec.treasury.amount ?? spec.creditAmount;
    const currency = spec.treasury.currency ?? spec.currency;
    const referenceNo = spec.treasury.referenceNo ?? voucherNo;
    const receiptNo = `TR-2026-${n}`;

    const bankAdvice = spec.documents.bankAdvice
      ? document(
          spec.seq,
          "bank-advice",
          `Bank credit advice ${receiptNo}`,
          { receiptNo, referenceNo, creditNoteNo },
          received,
          [
            "BANK CREDIT ADVICE",
            "",
            `Beneficiary account: ADB Treasury operating account`,
            `Value date: ${dateOnly(received)}`,
            `Amount credited: ${money(amount, currency)}`,
            `Remitter: ${supplierName}`,
            `Payment reference: ${referenceNo}`,
          ],
        )
      : undefined;
    if (bankAdvice) documents.push(bankAdvice);

    const receipt: TreasuryReceipt = {
      receiptNo,
      referenceNo,
      amountReceived: amount,
      currency,
      receivedDate: received,
      channel: spec.treasury.channel,
      confirmed: spec.treasury.confirmed,
      confirmationDate: spec.treasury.confirmed ? received : undefined,
      bankAdviceDocumentId: bankAdvice?.documentId,
    };
    records.push(
      record(
        "treasury",
        "refund-receipt",
        receiptNo,
        {
          receiptNo,
          referenceNo,
          ...(bankAdvice ? { documentId: bankAdvice.documentId } : {}),
        },
        receipt,
        received,
      ),
    );

    if (spec.documents.treasuryConfirmation) {
      documents.push(
        document(
          spec.seq,
          "treasury-confirmation",
          `Treasury confirmation ${receiptNo}`,
          { receiptNo, referenceNo, creditNoteNo },
          received,
          [
            "TREASURY RECEIPT CONFIRMATION",
            "",
            `Receipt no: ${receiptNo}`,
            `Reference: ${referenceNo}`,
            `Amount: ${money(amount, currency)}`,
            `Channel: ${spec.treasury.channel}`,
            `Confirmed on: ${dateOnly(received)}`,
          ],
        ),
      );
    }

    // Treasury also records the final processing outcome once confirmed.
    if (spec.treasury.confirmed) {
      const outcome: ProcessingOutcome = {
        creditNoteNo,
        status: "in-progress",
        note: "Receipt confirmed; awaiting Control Team decision",
        updatedDate: received,
      };
      records.push(record("treasury", "processing-outcome", creditNoteNo, { creditNoteNo }, outcome, received));
    }
  }

  if (spec.cashRoom) {
    const deposited = daysAgo(now, spec.cashRoom.daysAgo);
    const depositNo = `CR-2026-${n}`;

    const slip = spec.documents.depositSlip
      ? document(
          spec.seq,
          "deposit-slip",
          `Cash Room deposit slip ${depositNo}`,
          { depositNo, referenceNo: voucherNo, creditNoteNo },
          deposited,
          [
            "CASH ROOM DEPOSIT SLIP",
            "",
            `Deposit no: ${depositNo}`,
            `Reference: ${voucherNo}`,
            `Depositor: ${supplierName}`,
            `Amount: ${money(spec.cashRoom.amount, spec.cashRoom.currency)}`,
            `Date: ${dateOnly(deposited)}`,
            "Teller: T-07",
          ],
        )
      : undefined;
    if (slip) documents.push(slip);

    const receipt: CashRoomReceipt = {
      depositNo,
      referenceNo: voucherNo,
      amount: spec.cashRoom.amount,
      currency: spec.cashRoom.currency,
      depositedDate: deposited,
      tellerId: "T-07",
      depositSlipDocumentId: slip?.documentId,
    };
    records.push(
      record(
        "cashroom",
        "refund-receipt",
        depositNo,
        { depositNo, referenceNo: voucherNo, ...(slip ? { documentId: slip.documentId } : {}) },
        receipt,
        deposited,
      ),
    );
  }

  if (spec.outcome) {
    const updated = daysAgo(now, 1);
    const outcome: ProcessingOutcome = {
      creditNoteNo,
      status: spec.outcome.status,
      note: spec.outcome.note,
      updatedDate: updated,
    };
    records.push(record("disbursement", "processing-outcome", creditNoteNo, { creditNoteNo }, outcome, updated));
  }

  return { records, documents };
}

export function buildAdbSeed(now: Date): SeedData {
  const records: SourceRecord[] = [];
  const documents: SeedDocument[] = [];

  const fundsSeeded = daysAgo(now, 400);
  for (const sourceId of ["procurement", "disbursement"] as const) {
    for (const fund of FUND_SOURCES) {
      records.push(record(sourceId, "fund-source", fund.fundSourceId, { fundSourceId: fund.fundSourceId }, fund, fundsSeeded));
    }
  }
  // The vendor master lives in Procurement.
  for (const supplier of SUPPLIERS) {
    records.push(record("procurement", "supplier", supplier.supplierId, { supplierId: supplier.supplierId }, supplier, fundsSeeded));
  }

  for (const spec of SCENARIOS) {
    const built = buildCase(spec, now);
    records.push(...built.records);
    documents.push(...built.documents);
  }

  return {
    organisationId: ADB_ORGANISATION_ID,
    records,
    documents,
    scenarios: SCENARIOS.map((spec) => ({
      creditNoteNo: `CN-2026-${pad(spec.seq)}`,
      title: spec.title,
      demonstrates: spec.demonstrates,
    })),
  };
}
