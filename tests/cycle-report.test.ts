import { describe, expect, it } from "vitest";
import { cycleReportHeading } from "@/components/vx/CycleReport";

/**
 * The cycle report's header, pinned as a pure function. Its count is every
 * row the report lists, the closing `cycle_complete` row included, so the
 * header and the visible list always agree.
 */
describe("cycleReportHeading", () => {
  it("counts every listed row, the closing cycle_complete row included", () => {
    expect(
      cycleReportHeading("Day 3", [{ action: "ap_pay" }, { action: "compliance_sweep" }, { action: "cycle_complete" }])
    ).toBe("Day 3: the agent logged 3 entries");
  });

  it("counts a compliance sweep like any other row", () => {
    expect(cycleReportHeading("Day 4", [{ action: "compliance_sweep" }, { action: "ap_pay" }])).toBe(
      "Day 4: the agent logged 2 entries"
    );
  });

  it("says entry for a single row", () => {
    expect(cycleReportHeading("Wall-clock cycle", [{ action: "cycle_complete" }])).toBe(
      "Wall-clock cycle: the agent logged 1 entry"
    );
  });
});
