/**
 * Demo events for the ADB proof of concept: what the representative source
 * systems would record when something happens in the real world - a supplier
 * issues a credit note, Disbursement raises a voucher, Treasury's confirmation
 * arrives. Each event becomes records (and sometimes a document) in exactly
 * the shape the seed uses, so a case assessed afterwards picks them up as if
 * the systems had produced them.
 *
 * Driven from the BMS to stage a demonstration. Nothing here is a write-back:
 * these ARE the dummy source systems.
 */

import type { SourceReader } from "../../domain/assessment";
import type { DocumentRecord, SourceRecord } from "../../domain/types";
import {
  ADB_ORGANISATION_ID,
  type AdbDocumentKind,
  type AdbSourceId,
  type CashRoomReceipt,
  type Contract,
  type CreditNote,
  type FundSource,
  type Invoice,
  type RefundChannel,
  type RefundMethod,
  type RefundVoucher,
  type TreasuryReceipt,
  type TreasuryVoucherStatus,
} from "./records";

export interface EventDocument extends DocumentRecord {
  readonly lines: readonly string[];
}

export interface EventOutcome {
  readonly records: SourceRecord[];
  readonly documents: EventDocument[];
  /** What happened, for the BMS log: "Treasury confirmed 7,200.00 USD against VCH-2026-0011". */
  readonly summary: string;
  /** The case this touched. */
  readonly creditNoteNo: string;
}

export type DemoEvent =
  | {
      readonly type: "credit-note";
      readonly supplierName: string;
      readonly fundSourceId: string;
      readonly currency: string;
      readonly invoiceAmount: number;
      readonly creditAmount: number;
      readonly reason: string;
    }
  | {
      readonly type: "refund-voucher";
      readonly creditNoteNo: string;
      readonly refundMethod: RefundMethod;
      readonly refundChannel: RefundChannel;
    }
  | {
      readonly type: "treasury-receipt";
      readonly creditNoteNo: string;
      readonly amount?: number;
      readonly currency?: string;
      /** Defaults to the voucher number. Anything else stages a reference mismatch. */
      readonly referenceNo?: string;
      readonly confirmed: boolean;
      readonly channel: TreasuryReceipt["channel"];
      readonly withBankAdvice: boolean;
    }
  | {
      readonly type: "cashroom-deposit";
      readonly creditNoteNo: string;
      readonly amount?: number;
      readonly currency?: string;
      readonly withDepositSlip: boolean;
    }
  | { readonly type: "document"; readonly creditNoteNo: string; readonly kind: AdbDocumentKind };

class EventError extends Error {}
export { EventError };

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

function money(amount: number, currency: string): string {
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} ${currency}`;
}

function record<A extends object>(
  sourceId: AdbSourceId,
  recordType: string,
  recordId: string,
  references: Record<string, string>,
  attributes: A,
  updatedAt: string,
): SourceRecord<A> {
  return { organisationId: ADB_ORGANISATION_ID, sourceId, recordType, recordId, references, attributes, updatedAt };
}

function document(
  documentId: string,
  kind: AdbDocumentKind,
  title: string,
  references: Record<string, string>,
  uploadedAt: string,
  lines: readonly string[],
): EventDocument {
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

/** A short unique suffix so repeated events on one case never collide. */
function stamp(now: Date): string {
  return now.getTime().toString(36).toUpperCase().slice(-5);
}

async function loadCase(reader: SourceReader, creditNoteNo: string) {
  const anchor = await reader.get("disbursement", "credit-note", creditNoteNo);
  if (!anchor) throw new EventError(`No credit note ${creditNoteNo} in Disbursement.`);
  const creditNote = anchor.attributes as CreditNote;
  const vouchers = await reader.byReference("creditNoteNo", creditNoteNo, { sourceId: "disbursement", recordType: "refund-voucher" });
  const voucher = vouchers[0]?.attributes as RefundVoucher | undefined;
  const contract = (await reader.get("disbursement", "contract", creditNote.contractNo))?.attributes as Contract | undefined;
  return { creditNote, voucher, contract };
}

export async function applyEvent(event: DemoEvent, reader: SourceReader, now: Date, nextSequence: number): Promise<EventOutcome> {
  const at = now.toISOString();
  const day = at.slice(0, 10);

  switch (event.type) {
    case "credit-note": {
      const fund = (await reader.get("procurement", "fund-source", event.fundSourceId))?.attributes as FundSource | undefined;
      if (!fund) throw new EventError(`No fund source ${event.fundSourceId}.`);
      if (!(event.invoiceAmount > 0) || !(event.creditAmount > 0)) throw new EventError("Amounts must be positive.");
      if (event.creditAmount > event.invoiceAmount) throw new EventError("A credit note cannot exceed its invoice.");

      const n = pad(nextSequence);
      const contractNo = `CTR-2026-${n}`;
      const invoiceNo = `INV-2026-${n}`;
      const creditNoteNo = `CN-2026-${n}`;
      const supplierId = `S-2${n}`;
      const signed = new Date(now.getTime() - 120 * 86_400_000).toISOString();
      const paid = new Date(now.getTime() - 30 * 86_400_000).toISOString();

      const contract: Contract = {
        contractNo,
        supplierId,
        supplierName: event.supplierName,
        title: `TA services - ${event.supplierName}`,
        currency: event.currency,
        totalAmount: event.invoiceAmount * 4,
        fundSourceIds: [event.fundSourceId],
        signedDate: signed,
      };
      const invoice: Invoice = {
        invoiceNo,
        contractNo,
        supplierId,
        amount: event.invoiceAmount,
        currency: event.currency,
        fundSourceId: event.fundSourceId,
        status: "paid",
        paidDate: paid,
        paidVia: "electronic",
      };
      const documentId = `DOC-${n}-credit-note`;
      const creditNote: CreditNote = {
        creditNoteNo,
        invoiceNo,
        contractNo,
        supplierId,
        amount: event.creditAmount,
        currency: event.currency,
        issuedDate: at,
        reason: event.reason,
        documentId,
      };
      const records: SourceRecord[] = [];
      for (const sourceId of ["procurement", "disbursement"] as const) {
        records.push(record(sourceId, "contract", contractNo, { contractNo, supplierId }, contract, signed));
        records.push(record(sourceId, "invoice", invoiceNo, { invoiceNo, contractNo, supplierId, fundSourceId: event.fundSourceId }, invoice, paid));
        records.push(
          record(sourceId, "credit-note", creditNoteNo, { creditNoteNo, invoiceNo, contractNo, supplierId, documentId }, creditNote, at),
        );
      }
      const doc = document(documentId, "credit-note", `Credit note ${creditNoteNo}`, { creditNoteNo, invoiceNo, supplierId }, at, [
        "CREDIT NOTE",
        "",
        `Credit note no: ${creditNoteNo}`,
        `Against invoice: ${invoiceNo}`,
        `Contract: ${contractNo}`,
        `Supplier: ${event.supplierName} (${supplierId})`,
        `Amount: ${money(event.creditAmount, event.currency)}`,
        `Reason: ${event.reason}`,
        `Issued: ${day}`,
      ]);
      return {
        records,
        documents: [doc],
        creditNoteNo,
        summary: `${event.supplierName} issued credit note ${creditNoteNo} for ${money(event.creditAmount, event.currency)} against ${invoiceNo} (paid from ${fund.name}).`,
      };
    }

    case "refund-voucher": {
      const { creditNote, voucher } = await loadCase(reader, event.creditNoteNo);
      if (voucher) throw new EventError(`Voucher ${voucher.voucherNo} already exists for ${event.creditNoteNo}.`);
      const voucherNo = `VCH-${event.creditNoteNo.slice(3)}`;
      const raised: RefundVoucher = {
        voucherNo,
        creditNoteNo: creditNote.creditNoteNo,
        invoiceNo: creditNote.invoiceNo,
        amount: creditNote.amount,
        currency: creditNote.currency,
        refundMethod: event.refundMethod,
        refundChannel: event.refundChannel,
        raisedDate: at,
        status: "awaiting-receipt",
      };
      const status: TreasuryVoucherStatus = { voucherNo, treasuryStatus: "not-received", updatedDate: at };
      return {
        records: [
          record("disbursement", "refund-voucher", voucherNo, { voucherNo, creditNoteNo: creditNote.creditNoteNo, invoiceNo: creditNote.invoiceNo }, raised, at),
          record("treasury", "refund-voucher", voucherNo, { voucherNo, creditNoteNo: creditNote.creditNoteNo }, status, at),
        ],
        documents: [],
        creditNoteNo: creditNote.creditNoteNo,
        summary: `Disbursement raised voucher ${voucherNo} for ${money(creditNote.amount, creditNote.currency)}: ${event.refundMethod} via ${event.refundChannel}.`,
      };
    }

    case "treasury-receipt": {
      const { creditNote, voucher, contract } = await loadCase(reader, event.creditNoteNo);
      if (!voucher) throw new EventError(`${event.creditNoteNo} has no refund voucher yet - raise one first.`);
      const amount = event.amount ?? creditNote.amount;
      const currency = (event.currency ?? creditNote.currency).toUpperCase();
      const referenceNo = event.referenceNo?.trim() || voucher.voucherNo;
      const receiptNo = `TR-${creditNote.creditNoteNo.slice(3)}-${stamp(now)}`;
      const documents: EventDocument[] = [];
      let bankAdviceDocumentId: string | undefined;
      if (event.withBankAdvice) {
        bankAdviceDocumentId = `DOC-${creditNote.creditNoteNo.slice(8)}-bank-advice-${stamp(now)}`;
        documents.push(
          document(bankAdviceDocumentId, "bank-advice", `Bank credit advice ${receiptNo}`, { receiptNo, referenceNo, creditNoteNo: creditNote.creditNoteNo }, at, [
            "BANK CREDIT ADVICE",
            "",
            "Beneficiary account: ADB Treasury operating account",
            `Value date: ${day}`,
            `Amount credited: ${money(amount, currency)}`,
            `Remitter: ${contract?.supplierName ?? creditNote.supplierId}`,
            `Payment reference: ${referenceNo}`,
          ]),
        );
      }
      const receipt: TreasuryReceipt = {
        receiptNo,
        referenceNo,
        amountReceived: amount,
        currency,
        receivedDate: at,
        channel: event.channel,
        confirmed: event.confirmed,
        confirmationDate: event.confirmed ? at : undefined,
        bankAdviceDocumentId,
      };
      const status: TreasuryVoucherStatus = {
        voucherNo: voucher.voucherNo,
        treasuryStatus: event.confirmed ? "confirmed" : "received",
        updatedDate: at,
      };
      const records: SourceRecord[] = [
        record("treasury", "refund-receipt", receiptNo, { receiptNo, referenceNo, ...(bankAdviceDocumentId ? { documentId: bankAdviceDocumentId } : {}) }, receipt, at),
        record("treasury", "refund-voucher", voucher.voucherNo, { voucherNo: voucher.voucherNo, creditNoteNo: creditNote.creditNoteNo }, status, at),
      ];
      if (referenceNo === voucher.voucherNo) {
        records.push(
          record("disbursement", "refund-voucher", voucher.voucherNo, { voucherNo: voucher.voucherNo, creditNoteNo: creditNote.creditNoteNo, invoiceNo: creditNote.invoiceNo }, { ...voucher, status: "receipted" }, at),
        );
      }
      return {
        records,
        documents,
        creditNoteNo: creditNote.creditNoteNo,
        summary: `Treasury ${event.confirmed ? "confirmed" : "recorded"} receipt ${receiptNo}: ${money(amount, currency)} via ${event.channel} against reference ${referenceNo}${event.withBankAdvice ? ", with bank advice" : ""}.`,
      };
    }

    case "cashroom-deposit": {
      const { creditNote, voucher, contract } = await loadCase(reader, event.creditNoteNo);
      if (!voucher) throw new EventError(`${event.creditNoteNo} has no refund voucher yet - raise one first.`);
      const amount = event.amount ?? creditNote.amount;
      const currency = (event.currency ?? creditNote.currency).toUpperCase();
      const depositNo = `CR-${creditNote.creditNoteNo.slice(3)}-${stamp(now)}`;
      const documents: EventDocument[] = [];
      let depositSlipDocumentId: string | undefined;
      if (event.withDepositSlip) {
        depositSlipDocumentId = `DOC-${creditNote.creditNoteNo.slice(8)}-deposit-slip-${stamp(now)}`;
        documents.push(
          document(depositSlipDocumentId, "deposit-slip", `Cash Room deposit slip ${depositNo}`, { depositNo, referenceNo: voucher.voucherNo, creditNoteNo: creditNote.creditNoteNo }, at, [
            "CASH ROOM DEPOSIT SLIP",
            "",
            `Deposit no: ${depositNo}`,
            `Reference: ${voucher.voucherNo}`,
            `Depositor: ${contract?.supplierName ?? creditNote.supplierId}`,
            `Amount: ${money(amount, currency)}`,
            `Date: ${day}`,
            "Teller: T-07",
          ]),
        );
      }
      const deposit: CashRoomReceipt = {
        depositNo,
        referenceNo: voucher.voucherNo,
        amount,
        currency,
        depositedDate: at,
        tellerId: "T-07",
        depositSlipDocumentId,
      };
      return {
        records: [
          record("cashroom", "refund-receipt", depositNo, { depositNo, referenceNo: voucher.voucherNo, ...(depositSlipDocumentId ? { documentId: depositSlipDocumentId } : {}) }, deposit, at),
        ],
        documents,
        creditNoteNo: creditNote.creditNoteNo,
        summary: `The Cash Room recorded deposit ${depositNo} of ${money(amount, currency)}${event.withDepositSlip ? " with a deposit slip" : ""}.`,
      };
    }

    case "document": {
      const { creditNote, voucher, contract } = await loadCase(reader, event.creditNoteNo);
      const documentId = `DOC-${creditNote.creditNoteNo.slice(8)}-${event.kind}-${stamp(now)}`;
      const supplier = contract?.supplierName ?? creditNote.supplierId;
      const refs = { creditNoteNo: creditNote.creditNoteNo, ...(voucher ? { referenceNo: voucher.voucherNo } : {}) };
      const lines: Record<AdbDocumentKind, string[]> = {
        "credit-note": ["CREDIT NOTE", "", `Credit note no: ${creditNote.creditNoteNo}`, `Supplier: ${supplier}`, `Amount: ${money(creditNote.amount, creditNote.currency)}`, `Reason: ${creditNote.reason}`],
        "deposit-slip": ["CASH ROOM DEPOSIT SLIP", "", `Reference: ${voucher?.voucherNo ?? "(no voucher)"}`, `Depositor: ${supplier}`, `Amount: ${money(creditNote.amount, creditNote.currency)}`, `Date: ${day}`],
        "bank-advice": ["BANK CREDIT ADVICE", "", `Value date: ${day}`, `Amount credited: ${money(creditNote.amount, creditNote.currency)}`, `Remitter: ${supplier}`, `Payment reference: ${voucher?.voucherNo ?? "(no voucher)"}`],
        "treasury-confirmation": ["TREASURY RECEIPT CONFIRMATION", "", `Reference: ${voucher?.voucherNo ?? "(no voucher)"}`, `Amount: ${money(creditNote.amount, creditNote.currency)}`, `Confirmed on: ${day}`],
      };
      return {
        records: [],
        documents: [document(documentId, event.kind, `${event.kind.replace("-", " ")} ${documentId}`, refs, at, lines[event.kind])],
        creditNoteNo: creditNote.creditNoteNo,
        summary: `Uploaded a ${event.kind.replace("-", " ")} for ${creditNote.creditNoteNo}.`,
      };
    }
  }
}
