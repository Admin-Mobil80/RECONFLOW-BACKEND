/**
 * Representative record shapes for the ADB proof of concept.
 *
 * These describe the dummy databases that stand in for ADB's Procurement,
 * Disbursement, Treasury and Cash Room systems. They are tenant configuration:
 * the platform never imports this file, only ADB's adaptors and seed data do.
 *
 * Reference vocabulary (the keys in SourceRecord.references) is shared across
 * all four sources, because that is what lets evidence gathering follow a case
 * from a credit note to everything that mentions it:
 *
 *   contractNo · invoiceNo · fundSourceId · creditNoteNo · voucherNo ·
 *   referenceNo · supplierId · documentId
 */

import type { CurrencyCode, Organisation, Timestamp } from "../../domain/types";

export const ADB_ORGANISATION_ID = "adb";

/** Which record types each representative source holds — the Data Distribution Matrix. */
export const ADB_SOURCES = {
  procurement: ["contract", "invoice", "fund-source", "credit-note"],
  disbursement: [
    "contract",
    "invoice",
    "fund-source",
    "credit-note",
    "refund-voucher",
    "processing-outcome",
  ],
  treasury: ["refund-receipt", "refund-voucher", "processing-outcome"],
  cashroom: ["refund-receipt"],
  documents: ["document"],
} as const;

export type AdbSourceId = keyof typeof ADB_SOURCES;

export const ADB_ORGANISATION: Organisation = {
  organisationId: ADB_ORGANISATION_ID,
  name: "Asian Development Bank",
  baseCurrency: "USD",
  interfaces: [
    { id: "procurement", name: "Procurement system", kind: "proprietary", recordTypes: ADB_SOURCES.procurement },
    { id: "disbursement", name: "Disbursement system", kind: "proprietary", recordTypes: ADB_SOURCES.disbursement },
    { id: "treasury", name: "Treasury", kind: "proprietary", recordTypes: ADB_SOURCES.treasury },
    { id: "cashroom", name: "Cash Room", kind: "proprietary", recordTypes: ADB_SOURCES.cashroom },
    { id: "documents", name: "Document repository", kind: "standard", recordTypes: ADB_SOURCES.documents },
  ],
};

// --- Procurement & Disbursement (both hold these; they can disagree) --------

export type FundSourceType = "ordinary-capital" | "special-fund" | "trust-fund";

export interface FundSource {
  readonly fundSourceId: string;
  readonly name: string;
  readonly type: FundSourceType;
  readonly currency: CurrencyCode;
  /** Trust funds are financed by a donor, which is who a refund ultimately belongs to. */
  readonly donor?: string;
}

export interface Contract {
  readonly contractNo: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly title: string;
  readonly currency: CurrencyCode;
  readonly totalAmount: number;
  /** More than one entry makes the contract multi-funded. */
  readonly fundSourceIds: readonly string[];
  readonly signedDate: Timestamp;
}

export interface Invoice {
  readonly invoiceNo: string;
  readonly contractNo: string;
  readonly supplierId: string;
  readonly amount: number;
  readonly currency: CurrencyCode;
  /** The fund that actually paid this invoice. */
  readonly fundSourceId: string;
  readonly status: "open" | "paid" | "partially-paid";
  readonly paidDate?: Timestamp;
  readonly paidVia?: "electronic" | "cheque";
}

export interface CreditNote {
  readonly creditNoteNo: string;
  readonly invoiceNo: string;
  readonly contractNo: string;
  readonly supplierId: string;
  readonly amount: number;
  readonly currency: CurrencyCode;
  readonly issuedDate: Timestamp;
  readonly reason: string;
  readonly documentId?: string;
}

// --- Disbursement only --------------------------------------------------------

export type RefundMethod = "electronic" | "cash" | "cheque";
export type RefundChannel = "bank-transfer" | "cash-room" | "cheque-deposit";

export interface RefundVoucher {
  readonly voucherNo: string;
  readonly creditNoteNo: string;
  readonly invoiceNo: string;
  readonly amount: number;
  readonly currency: CurrencyCode;
  readonly refundMethod: RefundMethod;
  readonly refundChannel: RefundChannel;
  readonly raisedDate: Timestamp;
  readonly status: "raised" | "awaiting-receipt" | "receipted" | "processed";
}

export interface ProcessingOutcome {
  /** The credit note number identifies the refund case end to end. */
  readonly creditNoteNo: string;
  readonly status: "in-progress" | "completed" | "on-hold";
  readonly note: string;
  readonly updatedDate: Timestamp;
}

// --- Treasury -----------------------------------------------------------------

export interface TreasuryReceipt {
  readonly receiptNo: string;
  /** What Treasury was told the money is for — should be a voucher number. */
  readonly referenceNo: string;
  readonly amountReceived: number;
  readonly currency: CurrencyCode;
  readonly receivedDate: Timestamp;
  readonly channel: "wire" | "cash-room" | "cheque";
  readonly confirmed: boolean;
  readonly confirmationDate?: Timestamp;
  readonly bankAdviceDocumentId?: string;
}

/** Treasury's partial view of a voucher: it only knows whether money arrived. */
export interface TreasuryVoucherStatus {
  readonly voucherNo: string;
  readonly treasuryStatus: "not-received" | "received" | "confirmed";
  readonly updatedDate: Timestamp;
}

// --- Cash Room ----------------------------------------------------------------

export interface CashRoomReceipt {
  readonly depositNo: string;
  readonly referenceNo: string;
  readonly amount: number;
  readonly currency: CurrencyCode;
  readonly depositedDate: Timestamp;
  readonly tellerId: string;
  readonly depositSlipDocumentId?: string;
}

// --- Documents ----------------------------------------------------------------

export type AdbDocumentKind =
  | "credit-note"
  | "deposit-slip"
  | "bank-advice"
  | "treasury-confirmation";
