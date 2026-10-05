import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The cycle's wiring of the three-way match (docs/superpowers/specs/2026-10-05-three-way-match-design.md), pinned as
 * source structure where a full `runAgentCycle()` is out of proportion (see tests/orchestrator.test.ts). The rule is
 * tested directly: the guardrail in tests/guardrails.test.ts, the reopen in tests/follow-up.test.ts, and the AP stage
 * end to end in tests/ap-stage.test.ts. What is left is the follow-up's reads, one careless edit away from gone.
 */

const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");

describe("the cycle and the three-way match", () => {
  it("reads whether a purchase order is needed with every counterparty the AP stage pays", () => {
    const load = source.slice(source.indexOf('.from("invoices")\n      .select("*, counterparties('), source.indexOf('.eq("direction", "payable")\n      .in("status", ["pending", "matched", "scheduled"])'));
    expect(load).toContain("purchase_order_required");
  });

  it("hands the match to the AP guardrail", () => {
    const call = source.slice(source.indexOf("enforceApGuardrails({"), source.indexOf("});", source.indexOf("enforceApGuardrails({")));
    expect(call).toContain("match: { poReference: invoice.po_reference, goodsReceived: invoice.goods_received, purchaseOrderRequired }");
  });

  it("brings a payable that waited for a purchase order back to the agent once its counterparty is paid without them (M5)", () => {
    // The rule is factChanges' (tests/follow-up.test.ts). Its wiring: the frozen payables read the setting now, and each
    // decision's facts carry the setting it was taken under, absent for a decision recorded before the setting existed.
    const followUp = source.slice(source.indexOf("const frozenRows = unwrap("), source.indexOf("followUpHeldMilestones(db, budget)"));
    expect(followUp).toMatch(/counterparties\([^)]*purchase_order_required[^)]*\)/);
    expect(followUp).toContain('purchaseOrderRequired: typeof observed.purchaseOrderRequired === "boolean" ? observed.purchaseOrderRequired : undefined,');
    expect(followUp).toContain("purchaseOrderRequired: row.counterparties.purchase_order_required,");
  });
});
