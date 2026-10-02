import { describe, expect, it } from "vitest";
import { enforceApGuardrails, type ApGuardrailInput } from "@/lib/agent/guardrails";

/**
 * The AP guardrails while the spending limit is enforced on Arc (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md
 * R4, R7, R8): a payment the contract cannot carry is held for a person; one the contract would refuse is held with
 * the contract's own figures; a verdict that could not be read stops nothing, since the contract still refuses at send.
 */

const base: ApGuardrailInput = { action: "pay", reasoning: "Pay it.", amount: 2, riskLevel: "low", paymentLimit: 10 };

describe("the spending limit on Arc, in the AP guardrails", () => {
  it("lets a payment the contract allows through", () => {
    expect(enforceApGuardrails({ ...base, onChainLimit: { covered: true, verdict: { state: "allowed" } } })).toMatchObject({ blocked: false, rule: null });
  });

  it("holds a payment the contract cannot carry, saying why: EURC, or a payee on another chain", () => {
    const eurc = enforceApGuardrails({ ...base, currency: "EURC", fxAvailable: true, onChainLimit: { covered: false, uncoveredBecause: "eurc", verdict: null } });
    expect(eurc).toMatchObject({ blocked: true, status: "held", rule: "workspace.onchain_limit_route" });
    expect(eurc.reasoning).toContain("in EURC");
    const chain = enforceApGuardrails({ ...base, onChainLimit: { covered: false, uncoveredBecause: "another_chain", verdict: null } });
    expect(chain).toMatchObject({ blocked: true, status: "held", rule: "workspace.onchain_limit_route" });
    expect(chain.reasoning).toContain("another chain");
  });

  it("holds a payment the contract would refuse, naming the contract's figures, and sends nothing", () => {
    const daily = enforceApGuardrails({
      ...base,
      onChainLimit: { covered: true, verdict: { state: "refused", error: "OverDailyLimit", spent: 4, amount: 2, limit: 5 } },
    });
    expect(daily).toMatchObject({ blocked: true, status: "held", rule: "workspace.onchain_limit" });
    expect(daily.reasoning).toContain("4 USDC already paid today against its 5 USDC daily limit");
    const weekly = enforceApGuardrails({
      ...base,
      onChainLimit: { covered: true, verdict: { state: "refused", error: "OverWeeklyLimit", spent: 19, amount: 2, limit: 20 } },
    });
    expect(weekly.reasoning).toContain("19 USDC paid in the last 7 days against its 20 USDC 7-day limit");
    const again = enforceApGuardrails({ ...base, onChainLimit: { covered: true, verdict: { state: "refused", error: "AlreadyPaid" } } });
    expect(again).toMatchObject({ rule: "workspace.onchain_limit" });
    expect(again.reasoning).toContain("already made through it");
  });

  it("stops nothing on a verdict it could not read, or did not ask for", () => {
    expect(enforceApGuardrails({ ...base, onChainLimit: { covered: true, verdict: { state: "unreadable", reason: "timeout" } } }).blocked).toBe(false);
    expect(enforceApGuardrails({ ...base, onChainLimit: { covered: true, verdict: null } }).blocked).toBe(false);
  });

  it("checks the code's own limit first, and leaves a schedule alone: it is decided again on its day", () => {
    const both = enforceApGuardrails({
      ...base,
      outflowBudget: { dailyUsdc: 5, weeklyUsdc: null, spentToday: 4, spentThisWeek: 4, remaining: 1, binding: "day" },
      onChainLimit: { covered: true, verdict: { state: "refused", error: "OverDailyLimit", spent: 4, amount: 2, limit: 5 } },
    });
    expect(both.rule).toBe("workspace.outflow_budget");
    const scheduled = enforceApGuardrails({
      ...base,
      action: "schedule",
      onChainLimit: { covered: false, uncoveredBecause: "eurc", verdict: null },
    });
    expect(scheduled.blocked).toBe(false);
  });
});
