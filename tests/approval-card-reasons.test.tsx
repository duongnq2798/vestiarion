import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { overridesHold, REASON_HINT } from "@/components/ApprovalCard";

/**
 * Approvals asks why, in the moment (docs/superpowers/specs/2026-10-14-capability-and-reasons-design.md R10): Reject,
 * Return to agent and, on a payable the agent flagged or held on a rule, Approve and pay, each ask for a one-line reason
 * in their own dialog, optional, and never blocking. The dialogs open in a portal a static render leaves closed, so
 * their fields are checked against the component's source.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/verdicts", () => ({ giveVerdictAction: vi.fn() }));
vi.mock("@/app/actions/approvals", () => ({ approveInvoiceAction: vi.fn(), rejectInvoiceAction: vi.fn(), returnInvoiceAction: vi.fn(), addInvoiceDetailsAction: vi.fn() }));

const source = readFileSync(path.join(process.cwd(), "src/components/ApprovalCard.tsx"), "utf8");
const action = readFileSync(path.join(process.cwd(), "src/app/actions/approvals.ts"), "utf8");

describe("Approvals asks why, optionally", () => {
  it("asks on Reject, Return to agent and Approve and pay, each optional, one line, at most 280 characters", () => {
    expect(source).toContain('label="Why reject it?" optional');
    expect(source).toContain('label="Why return it?" optional');
    expect(source).toContain('label="Why pay it anyway?" optional');
    expect(source.match(/maxLength=\{280\}/g)?.length).toBeGreaterThanOrEqual(3);
    expect(REASON_HINT).toBe("Optional. One line helps the team improve the agent.");
  });

  it("never blocks the decision: no field is required, and the confirm buttons are never disabled for it", () => {
    expect(source).not.toMatch(/name="reason"[^>]*required/);
    expect(source).not.toMatch(/disabled=\{[^}]*[Rr]eason/);
  });

  it("sends the reason with the form the dialog confirms, and the action passes it on only when one was given", () => {
    expect(source).toContain('<input type="hidden" name="reason" value={returnReason} />');
    expect(source).toContain('{askWhyPaid && <input type="hidden" name="reason" value={payReason} />}');
    expect(action).toContain("return reason ? { reason } : {};");
  });

  it("asks why a payment goes ahead only where it overrides the agent: flagged, or held on one of its rules", () => {
    const held = { status: "held" as const, guardrailRule: null, heldForCash: false, heldForVerdict: false };
    expect(overridesHold({ ...held, status: "flagged" })).toBe(true);
    expect(overridesHold({ ...held, guardrailRule: "counterparty_limit" })).toBe(true);
    expect(overridesHold(held)).toBe(false);
    expect(overridesHold({ ...held, guardrailRule: "counterparty_limit", heldForCash: true })).toBe(false);
    expect(overridesHold({ ...held, status: "flagged", heldForVerdict: true })).toBe(false);
  });
});
