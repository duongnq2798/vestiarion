import { describe, expect, it } from "vitest";
import { planFollowUp, projectRoomChange } from "@/lib/agent/follow-up";
import { figuresSentence, NO_MONEY, obligationMinor, parseProjectForm, projectFigures, workState } from "@/lib/projects/model";

/**
 * A project's money in USDC cents (docs/superpowers/specs/2026-10-13-project-budgets-design.md P1, P7): what a bill sets
 * aside, counted as migration 0111's `project_minor` counts it; the project's figures; the form; and when the follow-up
 * decides a payment held for the budget again.
 */

describe("obligationMinor", () => {
  it("counts an amount to the cent above, on its six decimals, as the database does", () => {
    expect(obligationMinor("250.001")).toBe(25_001);
    expect(obligationMinor("250.000001")).toBe(25_001);
    expect(obligationMinor("250")).toBe(25_000);
    expect(obligationMinor("250.10")).toBe(25_010);
    // A number is read on the six decimals the database keeps: 0.30000000000000004 is 0.300000.
    expect(obligationMinor(0.1 + 0.2)).toBe(30);
    expect(obligationMinor(1200)).toBe(120_000);
  });
});

describe("projectFigures", () => {
  it("leaves the budget less its buffer, less what is reserved and paid, and says what is covered", () => {
    const figures = projectFigures(
      { budgetMinor: 1_000_000, bufferMinor: 100_000 },
      { reservedMinor: 300_000, paidMinor: 200_000, openMinor: 450_000, openCount: 3, unreservedMinor: 150_000, unreservedCount: 1 },
      { now: 1, last30Days: 2 }
    );
    expect(figures).toMatchObject({ availableMinor: 400_000, committedMinor: 500_000, overMinor: 0, coveragePercent: 66, holds: { now: 1, last30Days: 2 } });
    expect(figuresSentence(figures)).toBe("One bill or milestone waits for room: 1,500.00 USDC not set aside.");
  });

  it("says how far over a project is, and has no coverage with nothing open", () => {
    const figures = projectFigures({ budgetMinor: 100_000, bufferMinor: 0 }, { ...NO_MONEY, paidMinor: 130_000 });
    expect(figures).toMatchObject({ availableMinor: -30_000, overMinor: 30_000, coveragePercent: null });
    expect(figuresSentence(figures)).toBe("Over by 300.00 USDC: the agent sets nothing more aside until money is released or the budget is raised.");
    expect(figuresSentence(projectFigures({ budgetMinor: 100_000, bufferMinor: 0 }, NO_MONEY))).toBe("1,000.00 USDC left to set aside.");
  });
});

describe("parseProjectForm", () => {
  it("takes a name, a budget and a buffer within it", () => {
    expect(parseProjectForm({ name: "  Website   rebuild ", budget: "12,000", buffer: "500.50" })).toEqual({ ok: true, draft: { name: "Website rebuild", budgetMinor: 1_200_000, bufferMinor: 50_050 } });
    expect(parseProjectForm({ name: "Ops", budget: "0", buffer: "" })).toEqual({ ok: true, draft: { name: "Ops", budgetMinor: 0, bufferMinor: 0 } });
  });

  it("refuses what it cannot read, and a buffer past the budget", () => {
    expect(parseProjectForm({ name: " ", budget: "1", buffer: "" })).toMatchObject({ ok: false, field: "name" });
    expect(parseProjectForm({ name: "x".repeat(81), budget: "1", buffer: "" })).toMatchObject({ ok: false, field: "name" });
    expect(parseProjectForm({ name: "Ops", budget: "lots", buffer: "" })).toMatchObject({ ok: false, field: "budget" });
    expect(parseProjectForm({ name: "Ops", budget: "100", buffer: "-1" })).toMatchObject({ ok: false, field: "buffer" });
    expect(parseProjectForm({ name: "Ops", budget: "100", buffer: "100.01" })).toMatchObject({ ok: false, field: "buffer", message: "The buffer is part of the budget, so it cannot be more than the budget." });
  });
});

describe("workState", () => {
  it("says where a bill or milestone of a project stands", () => {
    expect(workState("bill", "pending", true)).toBe("reserved");
    expect(workState("bill", "held", false)).toBe("not_reserved");
    expect(workState("bill", "paid", false)).toBe("paid");
    expect(workState("bill", "rejected", false)).toBe("closed");
    expect(workState("milestone", "closed", false)).toBe("closed");
    expect(workState("milestone", "rejected", true)).toBe("reserved");
  });
});

describe("projectRoomChange", () => {
  const held = { projectId: "p1", neededMinor: 30_000 };

  it("decides a payment held for its project's budget again once the project has room, or it left the project", () => {
    expect(projectRoomChange(undefined, held)).toBeNull();
    expect(projectRoomChange({ projectId: "p1", availableMinor: 29_999 }, held)).toBeNull();
    expect(projectRoomChange({ projectId: "p1", availableMinor: null }, held)).toBeNull();
    expect(projectRoomChange({ projectId: "p1", availableMinor: 30_000 }, held)).toBe("its project has room for it again (300.00 USDC left to set aside)");
    expect(projectRoomChange({ projectId: null, availableMinor: null }, held)).toBe("it was taken out of its project");
    expect(projectRoomChange({ projectId: "p2", availableMinor: 0 }, held)).toBe("it was moved to another project");
  });
});

describe("the follow-up and a payment held for its project's budget", () => {
  const config = { staleAfterDays: 3, reEscalateAfterDays: 7 };
  const now = Date.parse("2026-10-13T09:00:00Z");
  const invoice = {
    id: "inv-1",
    status: "held",
    amount: 300,
    dueDate: "2026-10-20T00:00:00Z",
    decidedAt: "2026-10-13T08:00:00Z",
    escalatedAt: null,
    poReference: "PO-1",
    goodsReceived: true,
    riskLevel: "clear",
    paymentLimit: 1000,
  };
  const held = { poReference: "PO-1", goodsReceived: true, riskLevel: "clear", paymentLimit: 1000, heldForProject: { projectId: "p1", neededMinor: 30_000 } };

  it("reopens it once the project has room, and waits while it has none", () => {
    expect(planFollowUp({ ...invoice, project: { projectId: "p1", availableMinor: 30_000 } }, held, now, config)).toMatchObject({
      action: "reopen",
      changes: ["its project has room for it again (300.00 USDC left to set aside)"],
    });
    expect(planFollowUp({ ...invoice, project: { projectId: "p1", availableMinor: 100 } }, held, now, config).action).toBe("wait");
    // Not read, because nothing waited on it: nothing to reopen on.
    expect(planFollowUp(invoice, held, now, config).action).toBe("wait");
  });
});
