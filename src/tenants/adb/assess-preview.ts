/**
 * Runs the supplier-refund case type over every seeded case, in memory.
 * `npm run assess:preview` — no AWS, no model. Pass a credit note number to
 * see one case in full.
 */

import { assess } from "../../domain/assessment";
import { InMemorySourceReader, StaticFxRates } from "../../domain/in-memory";
import { supplierRefund } from "./case-types/supplier-refund";
import { ADB_ORGANISATION } from "./records";
import { buildAdbSeed } from "./seed";

async function main() {
  const now = new Date();
  const seed = buildAdbSeed(now);
  const reader = new InMemorySourceReader(seed.records, seed.documents);
  // Indicative rates for a local run; production uses a live provider.
  const fx = new StaticFxRates("USD", { PHP: 56.0, EUR: 0.92, INR: 83.5 }, now.toISOString());

  const anchors = seed.records.filter(
    (r) => r.sourceId === supplierRefund.anchor.sourceId && r.recordType === supplierRefund.anchor.recordType,
  );
  const only = process.argv[2];

  console.log(`${"case".padEnd(14)}${"verdict".padEnd(11)}${"classification".padEnd(32)}${"conf".padEnd(6)}${"stage".padEnd(20)}${"days".padEnd(6)}exceptions`);
  for (const anchor of anchors) {
    if (only && anchor.recordId !== only) continue;
    const a = await assess(supplierRefund, anchor, reader, fx, ADB_ORGANISATION.baseCurrency, now);
    const ex = a.exceptions.map((e) => `${e.id}${e.severity === "blocking" ? "!" : ""}`).join(", ");
    console.log(
      `${a.caseId.padEnd(14)}${a.readiness.verdict.padEnd(11)}${a.classification.label.padEnd(32)}${String(a.classification.confidence + "%").padEnd(6)}${a.lifecycle.stage.padEnd(20)}${String(a.lifecycle.businessDaysInStage + (a.lifecycle.stale ? "*" : "")).padEnd(6)}${ex}`,
    );

    if (only) {
      console.log("\nReadiness checks:");
      for (const c of a.readiness.checks) console.log(`  [${c.passed ? "x" : " "}] ${c.label}\n      ${c.detail}`);
      console.log("\nClassification signals:");
      for (const s of a.classification.signals) console.log(`  [${s.satisfied ? "x" : " "}] ${s.label} (${s.weight})\n      ${s.detail}`);
      console.log(`\nRule: ${a.classification.rule}`);
      console.log("\nExceptions:");
      for (const e of a.exceptions) console.log(`  ${e.severity.toUpperCase()} ${e.title}\n      ${e.detail}\n      Action: ${e.actionRequired}`);
      console.log(`\nLifecycle: ${a.lifecycle.stageLabel} since ${a.lifecycle.enteredAt.slice(0, 10)}, ${a.lifecycle.businessDaysInStage} business days${a.lifecycle.stale ? " - STALE" : ""}`);
      if (a.lifecycle.escalation) console.log(`  ${a.lifecycle.escalation}`);
      console.log("\nSummary facts for the narrator:");
      for (const f of a.summaryFacts) console.log(`  - ${f}`);
      console.log(`\nFX snapshot: ${JSON.stringify(a.fx)}`);
    }
  }
  console.log("\n(* = stale; ! = blocking)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
