/**
 * Master list of reasons a supplier issues a credit note, as the ADB
 * demonstration offers them. Tenant configuration, not source data: the
 * reason travels on the credit note record as plain text, so a reason typed
 * by hand still works.
 */
export const CREDIT_NOTE_REASONS: readonly string[] = [
  "Deliverable descoped by agreement",
  "Milestone partially delivered",
  "Services not performed",
  "Duplicate billing",
  "Rate correction",
  "Quantity variance on delivery",
  "Scope or survey area reduced",
  "Licence count reduced after acceptance",
  "Unused per diem or travel returned",
  "Freight or surcharge withdrawn",
  "Overpayment identified in audit",
  "Tax withheld in error",
  "Contract terminated early",
  "Exchange rate adjustment",
];
