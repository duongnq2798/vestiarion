import { describe, expect, it } from "vitest";
import { needsTwoApprovals, parseTwoApprovalsForm, TWO_APPROVALS_RULE, weighedUsdc } from "@/lib/two-approvals";

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
