import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The cycle's wiring of document checks (docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md DK2,
 * DK7, DK8), pinned as source structure where a full `runAgentCycle()` is out of proportion (see
 * tests/orchestrator.test.ts), as tests/three-way-match-cycle.test.ts pins the match. The rule itself is tested in
 * tests/guardrails.test.ts, the AP stage end to end in tests/ap-stage.test.ts, and the stage in
 * tests/document-checks-stage.test.ts.
 */

const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");
const apStage = source.slice(source.indexOf("export async function runApStage("), source.indexOf("\n}\n", source.indexOf("export async function runApStage(")));
const guardrailCall = source.slice(source.indexOf("enforceApGuardrails({"), source.indexOf("});", source.indexOf("enforceApGuardrails({")));
const decisionFactsAt = source.indexOf("export function payableDecisionFacts(");
const decisionFacts = source.slice(decisionFactsAt, source.indexOf("\n}\n", decisionFactsAt));

describe("the cycle and a vendor's document", () => {
  it("checks documents after screening and before the follow-up, which reopens a bill whose purchase order a document added (DK2, DK7)", () => {
    const run = source.indexOf("async function executeCycle(");
    const compliance = source.indexOf('stage("compliance"', run);
    const checks = source.indexOf('stage("document_checks"', run);
    const followUp = source.indexOf('stage("follow_up"', run);
    expect(compliance).toBeGreaterThan(run);
    expect(checks).toBeGreaterThan(compliance);
    expect(followUp).toBeGreaterThan(checks);
    expect(source.slice(checks, followUp)).toContain("lines.push(...(await checkReceivedDocuments(db)));");
  });

  it("reads which bills a vendor's document completed once per AP stage, before the payables are decided", () => {
    expect(apStage.match(/vendorDocumentsOf\(/g)).toHaveLength(1);
    expect(apStage.indexOf("vendorDocumentsOf(")).toBeLessThan(apStage.indexOf("for (const invoice of payables)"));
    expect(apStage).toContain("vendorDocument: (invoiceId) => vendorDocuments.get(invoiceId) ?? null,");
  });

  it("hands the document to the AP guardrail, as its last rule's input", () => {
    expect(guardrailCall).toContain("vendorDocument: vendorDocument ? { source: vendorDocument.source, vendorName: counterparty.name } : null,");
  });

  it("keeps the follow-up's facts on each decision's `observed`, which `document_checked` never carries", () => {
    expect(decisionFacts).toContain("observed");
    expect(decisionFacts).not.toContain("document_checked");
  });
});
