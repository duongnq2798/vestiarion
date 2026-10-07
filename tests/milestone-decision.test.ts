import { describe, expect, it } from "vitest";
import { milestoneDecision } from "@/components/vx/map";
import type { LedgerEntry } from "@/lib/ledger";
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

const evidenceRow = (row: MilestoneRow) => milestoneDecision(row, [], { network: "arc-testnet" }).evidence.find((item) => item.label === "Evidence");

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
    const decision = milestoneDecision(milestone({ verification_source: "https://github.com/acme/widgets/pull/42" }), [], { network: "arc-testnet" });
    expect(decision.evidence.find((item) => item.label === "Evidence")).toBeUndefined();
    expect(decision.evidence.find((item) => item.label === "Verified by")?.href).toBe("https://github.com/acme/widgets/pull/42");
  });

  it.each([null, "timesheet:kimai", "http://example.com/work", "javascript:alert(1)"])("shows no link for %j", (source) => {
    expect(evidenceRow(milestone({ verification_source: source }))).toBeUndefined();
  });
});

describe("milestoneDecision: a release held by a rule that is not a limit (2026-10-07)", () => {
  it("names the new payee rule and why, not the payment limit", () => {
    const entry = {
      seq: 23, id: "e23", ts: "2026-10-07T09:00:00.000Z", actor: "agent", domain: "contractor", action: "milestone_release", summary: "",
      detail: { milestoneId: "ms-1", guardrailBlocked: true, guardrailRule: "counterparty.new_payee", observed: { paymentLimit: 50, riskLevel: "clear" } },
    } as unknown as LedgerEntry;
    const decision = milestoneDecision(milestone({ status: "held", verified: true }), [entry], { network: "arc-testnet" });
    expect(decision.guardrail).toEqual({ rule: "counterparty.new_payee", attempted: 12.5, reason: "the first payment to this address, and only one person stands behind it" });
  });
});

describe("milestoneDecision: a release held for the agent's spending limit (outflow budget spec §4)", () => {
  it("sets the amount against what the limit left, and names the rule", () => {
    const entry = {
      seq: 22, id: "e22", ts: "2026-10-02T09:00:00.000Z", actor: "agent", domain: "contractor", action: "milestone_release", summary: "",
      detail: {
        milestoneId: "ms-1", guardrailBlocked: true, guardrailRule: "workspace.outflow_budget", observed: { paymentLimit: 50, riskLevel: "clear" },
        outflowBudget: { dailyUsdc: 20, weeklyUsdc: null, spentToday: 15, spentThisWeek: 15, remaining: 5, binding: "day" },
      },
    } as unknown as LedgerEntry;
    const decision = milestoneDecision(milestone({ status: "held", verified: true }), [entry], { network: "arc-testnet" });
    expect(decision.guardrail).toEqual({ rule: "workspace.outflow_budget", attempted: 12.5, attemptedToken: "USDC", limit: 5, limitToken: "USDC", note: "left of the 20.00 USDC daily spending limit; 15.00 USDC already paid today" });
  });
});

describe("milestoneDecision: a milestone the agent has not paid yet says what it waits for", () => {
  const verified = milestone({ status: "verified", verified: true, verification_method: "manual", verification_status: "verified", contractor_name: "Mr Pop", amount: 1 });

  it("waits on a person to confirm the payee's new address: held for them, never Scheduled, with the contractor's own screening", () => {
    const decision = milestoneDecision(verified, [], { network: "arc-testnet", riskLevel: "clear", waiting: "unconfirmed" });
    expect(decision.outcome).toBe("held");
    expect(decision.outcomeLabel).toBe("Address to confirm");
    expect(decision.reasoning).toBe(
      "Verified. Mr Pop's address changed and no one has confirmed it yet: confirm it on Counterparties, and the agent decides on pay within a minute."
    );
    expect(decision.evidence.find((item) => item.label === "Risk")?.value).toBe("clear");
  });

  it("waits for the payee to add an address, or for the agent's decision", () => {
    expect(milestoneDecision(verified, [], { network: "arc-testnet", waiting: "no_address" })).toMatchObject({ outcomeLabel: "Waiting for an address" });
    const deciding = milestoneDecision(verified, [], { network: "arc-testnet" });
    expect(deciding).toMatchObject({ outcomeLabel: "Being decided", reasoning: "Verified. The agent decides on pay within a minute." });
    expect(deciding.outcome).not.toBe("held");
  });

  it("waits for verification while pending", () => {
    expect(milestoneDecision(milestone(), [], { network: "arc-testnet" })).toMatchObject({ outcomeLabel: "Awaiting verification", reasoning: "The agent is waiting for milestone verification." });
  });
});
