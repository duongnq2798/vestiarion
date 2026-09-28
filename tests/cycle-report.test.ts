import { describe, expect, it } from "vitest";
import { cycleReportEntryCount } from "@/components/vx/CycleReport";

/**
 * The cycle report header's entry count, pinned as a pure function. It must
 * count every row the report lists — not only ones the UI used to call
 * "decisions", which excluded a compliance sweep and disagreed with the
 * `cycle_complete` ledger entry's own count — minus the closing
 * `cycle_complete` row itself when the report includes it.
 */
describe("cycleReportEntryCount", () => {
  it("counts every listed row when the closing cycle_complete row is not among them", () => {
    expect(
      cycleReportEntryCount([{ action: "ap_pay" }, { action: "compliance_sweep" }])
    ).toBe(2);
  });

  it("excludes the closing cycle_complete row from the count", () => {
    expect(
      cycleReportEntryCount([{ action: "ap_pay" }, { action: "compliance_sweep" }, { action: "cycle_complete" }])
    ).toBe(2);
  });

  it("is zero for an empty list", () => {
    expect(cycleReportEntryCount([])).toBe(0);
  });
});
