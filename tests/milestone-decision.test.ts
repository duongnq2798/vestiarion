import { describe, expect, it } from "vitest";
import { milestoneDecision } from "@/components/vx/map";
import type { MilestoneRow } from "@/lib/queries";

/**
 * `milestoneDecision` (src/components/vx/map.ts) turns a milestone row into
 * the `Decision` a `DecisionCard` renders. A milestone added from the
 * Contractors page may carry any https link as its evidence; the card links
 * to it, so whoever verifies the work by hand can open what was delivered.
 */

function milestone(overrides: Partial<MilestoneRow> = {}): MilestoneRow {
  return {
    id: "ms-1",
    contractor_id: "cp-1",
    contractor_name: "Linh Design",
    title: "Five October posts",
    amount: 12.5,
    verification_source: null,
    verification_method: "unverified",
    verification_status: "unverified",
    verification_checked_at: null,
    verified_at: null,
    verification_detail: {},
    verified: false,
    status: "pending",
    agent_reasoning: null,
    tx_ref: null,
    ...overrides,
  };
}

const evidenceRow = (row: MilestoneRow) => milestoneDecision(row, []).evidence.find((item) => item.label === "Evidence");

describe("milestoneDecision: evidence link", () => {
  it("links an https evidence link by its host", () => {
    expect(evidenceRow(milestone({ verification_source: "https://www.canva.com/design/DAG123/view" }))).toEqual({
      label: "Evidence",
      value: "www.canva.com",
      href: "https://www.canva.com/design/DAG123/view",
      state: "neutral",
    });
  });

  it("leaves a pull request to the Verified by row, which already links it", () => {
    const decision = milestoneDecision(milestone({ verification_source: "https://github.com/acme/widgets/pull/42" }), []);
    expect(decision.evidence.find((item) => item.label === "Evidence")).toBeUndefined();
    expect(decision.evidence.find((item) => item.label === "Verified by")?.href).toBe("https://github.com/acme/widgets/pull/42");
  });

  it.each([null, "timesheet:kimai", "http://example.com/work", "javascript:alert(1)"])("shows no link for %j", (source) => {
    expect(evidenceRow(milestone({ verification_source: source }))).toBeUndefined();
  });
});
