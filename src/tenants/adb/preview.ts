/**
 * Prints what the seed would load, without touching AWS. `npm run seed:preview`.
 */

import { buildPdf } from "../../lib/mini-pdf";
import { ADB_SOURCES } from "./records";
import { buildAdbSeed } from "./seed";

const seed = buildAdbSeed(new Date());

console.log(`Organisation: ${seed.organisationId}`);
console.log(`Scenarios:    ${seed.scenarios.length}`);
console.log(`Records:      ${seed.records.length}`);
console.log(`Documents:    ${seed.documents.length}\n`);

for (const sourceId of Object.keys(ADB_SOURCES)) {
  const counts = new Map<string, number>();
  for (const r of seed.records.filter((r) => r.sourceId === sourceId)) {
    counts.set(r.recordType, (counts.get(r.recordType) ?? 0) + 1);
  }
  const summary = [...counts].map(([type, n]) => `${type}=${n}`).join("  ");
  console.log(`${sourceId.padEnd(13)} ${summary || "(documents only)"}`);
}

console.log("\nScenarios:");
for (const s of seed.scenarios) console.log(`  ${s.creditNoteNo}  ${s.title}\n${"".padEnd(16)}${s.demonstrates}`);

// Every record must be declared for its source, and every reference must
// point at something that exists somewhere — except deliberately broken ones.
const declared = ADB_SOURCES as Record<string, readonly string[]>;
const known = new Set(seed.records.flatMap((r) => Object.values(r.references)));
for (const doc of seed.documents) for (const v of Object.values(doc.references)) known.add(v);
const problems: string[] = [];
for (const r of seed.records) {
  if (!declared[r.sourceId]?.includes(r.recordType)) {
    problems.push(`${r.sourceId} does not declare record type ${r.recordType}`);
  }
}
const dangling = seed.records
  .flatMap((r) => Object.entries(r.references).map(([k, v]) => ({ r, k, v })))
  .filter(({ k, v }) => k === "referenceNo" && !seed.records.some((o) => o.references.voucherNo === v));
for (const d of dangling) problems.push(`${d.r.sourceId}/${d.r.recordType} ${d.r.recordId} references unknown voucher ${d.v} (expected only in the mismatch scenario)`);

console.log(`\nPDF sample: ${buildPdf(seed.documents[0].lines).length} bytes for ${seed.documents[0].documentId}`);
console.log(problems.length ? `\nChecks:\n  ${problems.join("\n  ")}` : "\nChecks: all record types declared; references resolve");
