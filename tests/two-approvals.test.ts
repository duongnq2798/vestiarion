import { describe, expect, it } from "vitest";
import { excludedSlots, mayApproveNow, needsTwoApprovals, parseTwoApprovalsForm, TWO_APPROVALS_RULE, twoApprovalsLine, weighedUsdc } from "@/lib/two-approvals";

/** The rule of two approvals (docs/superpowers/specs/2026-10-05-two-approvals-design.md T1, T2). Pure. */

describe("weighedUsdc", () => {
  it("is a USDC payment's amount, and a EURC payment's USDC value", () => {
    expect(weighedUsdc({ amount: 120, currency: "USDC" })).toBe(120);
    expect(weighedUsdc({ amount: 100, currency: "EURC", usdcValue: 108.2 })).toBe(108.2);
  });

  it("is not known for a EURC payment with no USDC value", () => {
    expect(weighedUsdc({ amount: 100, currency: "EURC", usdcValue: null })).toBeNull();
    expect(weighedUsdc({ amount: 100, currency: "EURC" })).toBeNull();
  });
});

describe("needsTwoApprovals", () => {
  it("is never needed with no figure set", () => {
    expect(needsTwoApprovals({ amount: 1_000_000, currency: "USDC" }, null)).toBe(false);
    expect(needsTwoApprovals({ amount: 100, currency: "EURC" }, null)).toBe(false);
  });

  it("is needed strictly above the figure", () => {
    expect(needsTwoApprovals({ amount: 100.000001, currency: "USDC" }, 100)).toBe(true);
    expect(needsTwoApprovals({ amount: 100, currency: "USDC" }, 100)).toBe(false);
    expect(needsTwoApprovals({ amount: 99, currency: "USDC" }, 100)).toBe(false);
  });

  it("weighs EURC at its USDC value, and one with no value as above", () => {
    expect(needsTwoApprovals({ amount: 95, currency: "EURC", usdcValue: 103 }, 100)).toBe(true);
    expect(needsTwoApprovals({ amount: 95, currency: "EURC", usdcValue: 99 }, 100)).toBe(false);
    expect(needsTwoApprovals({ amount: 1, currency: "EURC", usdcValue: null }, 100)).toBe(true);
  });
});

describe("parseTwoApprovalsForm", () => {
  it("reads a figure in USDC, and a blank as off", () => {
    expect(parseTwoApprovalsForm("250")).toEqual({ ok: true, above: 250 });
    expect(parseTwoApprovalsForm(" 1,000.5 ")).toEqual({ ok: true, above: 1000.5 });
    expect(parseTwoApprovalsForm("")).toEqual({ ok: true, above: null });
  });

  it("refuses anything but a positive number of USDC with at most 6 decimals", () => {
    expect(parseTwoApprovalsForm("abc")).toEqual({ ok: false, message: "The figure must be a number of USDC." });
    expect(parseTwoApprovalsForm("0")).toEqual({ ok: false, message: "The figure must be more than 0 USDC." });
    expect(parseTwoApprovalsForm("-5")).toEqual({ ok: false, message: "The figure must be more than 0 USDC." });
    expect(parseTwoApprovalsForm("1.1234567")).toEqual({ ok: false, message: "The figure can have at most 6 decimal places." });
  });
});

describe("TWO_APPROVALS_RULE", () => {
  it("names the guardrail rule", () => {
    expect(TWO_APPROVALS_RULE).toBe("workspace.two_approvals");
  });
});

describe("excludedSlots (two approvals T5)", () => {
  it("lets those left out give none of the two while two others can approve, one with one other, both with none", () => {
    expect(excludedSlots(3)).toBe(0);
    expect(excludedSlots(2)).toBe(0);
    expect(excludedSlots(1)).toBe(1);
    expect(excludedSlots(0)).toBe(2);
  });
});

describe("mayApproveNow (two approvals T5)", () => {
  const ENTERED = "a-entered";
  const GAVE = "a-gave-address";
  const OTHER = "a-other";
  const facts = (slots: number, approvals: Array<{ by: string; at: string }> = []) => ({ excluded: [ENTERED, GAVE], excludedSlots: slots, approvals });

  it("lets anyone not left out approve", () => {
    expect(mayApproveNow(facts(0), OTHER)).toBe(true);
  });

  it("keeps those left out from approving while two others can", () => {
    expect(mayApproveNow(facts(0), ENTERED)).toBe(false);
  });

  it("lets one of them give one approval while one other can, and keeps the second for that other", () => {
    expect(mayApproveNow(facts(1), ENTERED)).toBe(true);
    expect(mayApproveNow(facts(1, [{ by: ENTERED, at: "t" }]), GAVE)).toBe(false);
    expect(mayApproveNow(facts(1, [{ by: ENTERED, at: "t" }]), OTHER)).toBe(true);
  });

  it("lets both give one each when no one else can approve", () => {
    expect(mayApproveNow(facts(2, [{ by: ENTERED, at: "t" }]), GAVE)).toBe(true);
  });
});

describe("twoApprovalsLine (two approvals T8)", () => {
  const facts = (approvals: Array<{ by: string; at: string }>) => ({ above: 100, approvals, excluded: [], excludedSlots: 0, approvers: 3 });
  const AT = "2026-10-05T08:00:00.000Z";

  it("says no one approved it yet", () => {
    expect(twoApprovalsLine(facts([]), "me")).toBe("Payments above 100 USDC need two approvals. No one has approved it yet.");
  });

  it("names who approved it, by email, or You", () => {
    expect(twoApprovalsLine(facts([{ by: "linh", at: AT }]), "me", { linh: "linh@acme.test" })).toBe(
      "Payments above 100 USDC need two approvals. linh@acme.test approved it on Oct 5, 2026, 08:00 UTC. One more approval, by another person, pays it."
    );
    expect(twoApprovalsLine(facts([{ by: "me", at: AT }]), "me")).toContain("You approved it on Oct 5, 2026, 08:00 UTC.");
  });

  it("says the next approval pays it once two people stand behind it", () => {
    expect(twoApprovalsLine(facts([{ by: "linh", at: AT }, { by: "me", at: AT }]), "me", { linh: "linh@acme.test" }, "Pay now")).toBe(
      "Payments above 100 USDC need two approvals. linh@acme.test and you approved it, so the next Pay now pays it."
    );
  });
});
