import { describe, expect, it } from "vitest";
import {
  actionLabel,
  CLAUDE_PRICES,
  costWords,
  fromMicros,
  modelCallCost,
  monthOf,
  parseModelPrices,
  summarizeUsage,
  toMicros,
  usageLimits,
  type LimitFacts,
  type UsageRow,
} from "@/lib/usage/model";

/**
 * What a workspace used, summed and said (docs/superpowers/specs/2026-10-13-accountant-console-design.md U1 to U4): exact
 * sums per currency, never across currencies; a model call's cost from its tokens and a price that is known, never a
 * guess; and each limit with what stops and who acts.
 */

const row = (fields: Partial<UsageRow>): UsageRow => ({
  kind: "model_call", action: "payable", quantity: 1, input_tokens: null, output_tokens: null, cost: null, cost_currency: null, ok: true, ...fields,
});

describe("summarizeUsage", () => {
  it("counts each kind and what it was for, with tokens, and sums costs exactly per currency", () => {
    const summary = summarizeUsage([
      row({ input_tokens: 1000, output_tokens: 200, cost: "0.004000", cost_currency: "USD" }),
      row({ input_tokens: 500, output_tokens: 100, cost: "0.002000", cost_currency: "USD" }),
      row({ action: "extraction", ok: false }),
      row({ kind: "x402_purchase", action: "payee_history", cost: "0.01", cost_currency: "USDC" }),
      row({ kind: "x402_purchase", action: "payee_history", cost: "0.01", cost_currency: "USDC" }),
      row({ kind: "circle_transfer", action: "payment_batch", quantity: 3, cost: "0.003190", cost_currency: "USD" }),
      row({ kind: "email", action: "invitation" }),
    ]);
    const model = summary.kinds.find((kind) => kind.kind === "model_call")!;
    expect(model).toMatchObject({ count: 3, failed: 1, inputTokens: 1500, outputTokens: 300, costs: [{ currency: "USD", amount: "0.006000" }], costUnknown: 1 });
    expect(model.lines.map((line) => [line.action, line.count])).toEqual([["payable", 2], ["extraction", 1]]);
    expect(summary.kinds.find((kind) => kind.kind === "x402_purchase")!.costs).toEqual([{ currency: "USDC", amount: "0.020000" }]);
    expect(summary.kinds.find((kind) => kind.kind === "circle_transfer")!.count).toBe(3);
    expect(summary.kinds.map((kind) => kind.kind)).toEqual(["model_call", "circle_transfer", "x402_purchase", "email", "connector_sync"]);
    expect(summary.kinds.find((kind) => kind.kind === "connector_sync")!.count).toBe(0);
  });

  it("names each connector's syncs by the tool's own name, Asana's too", () => {
    expect(["xero", "quickbooks", "zohobooks", "hubspot", "pipedrive", "asana"].map(actionLabel)).toEqual([
      "Xero",
      "QuickBooks",
      "Zoho Books",
      "HubSpot",
      "Pipedrive",
      "Asana",
    ]);
  });

  it("never adds one currency to another, within a kind either", () => {
    const summary = summarizeUsage([
      row({ kind: "x402_purchase", action: "payee_history", cost: "0.01", cost_currency: "USDC" }),
      row({ kind: "x402_purchase", action: "payee_history", cost: "0.02", cost_currency: "EURC" }),
      row({ kind: "x402_purchase", action: "payee_history", cost: "0.5", cost_currency: "USD" }),
    ]);
    expect(summary.kinds.find((kind) => kind.kind === "x402_purchase")!.costs).toEqual([
      { currency: "USD", amount: "0.500000" },
      { currency: "USDC", amount: "0.010000" },
      { currency: "EURC", amount: "0.020000" },
    ]);
  });

  it("sums without floating point drift", () => {
    const rows = Array.from({ length: 10 }, () => row({ cost: "0.1", cost_currency: "USD" }));
    expect(summarizeUsage(rows).kinds[0].costs).toEqual([{ currency: "USD", amount: "1.000000" }]);
    expect(toMicros("0.1234567")).toBe(123_456);
    expect(toMicros(0.3)).toBe(300_000);
    expect(toMicros("not a number")).toBe(0);
    expect(fromMicros(1_000_001)).toBe("1.000001");
  });
});

describe("costWords", () => {
  it("shows a dollar cost with the places it needs, and a token in its own name", () => {
    expect(costWords({ currency: "USD", amount: "0.004100" })).toBe("$0.0041");
    expect(costWords({ currency: "USD", amount: "12.500000" })).toBe("$12.50");
    expect(costWords({ currency: "USDC", amount: "1234.000000" })).toBe("1,234.00 USDC");
  });
});

describe("modelCallCost", () => {
  it("prices a Claude model from its list price, and any other only from the deployment's own price", () => {
    expect(CLAUDE_PRICES["claude-sonnet-5"]).toEqual({ input: 2, output: 10 });
    expect(modelCallCost("claude-sonnet-5", { input: 1_000_000, output: 100_000 })).toBe("3.000000");
    expect(modelCallCost("deepseek-chat", { input: 1000, output: 1000 })).toBeNull();
    expect(modelCallCost("deepseek-chat", { input: 1_000_000, output: 1_000_000 }, { "deepseek-chat": { input: 0.28, output: 0.42 } })).toBe("0.700000");
  });

  it("has no cost without the tokens", () => {
    expect(modelCallCost("claude-sonnet-5", null)).toBeNull();
    expect(modelCallCost("claude-sonnet-5", { input: null, output: 10 })).toBeNull();
    expect(modelCallCost(null, { input: 1, output: 1 })).toBeNull();
  });
});

describe("parseModelPrices", () => {
  it("reads model=input/output pairs and leaves out anything that does not read", () => {
    expect(parseModelPrices("deepseek-chat=0.28/0.42, gpt-5 = 1.25 / 10,broken,also=1")).toEqual({
      "deepseek-chat": { input: 0.28, output: 0.42 },
      "gpt-5": { input: 1.25, output: 10 },
    });
    expect(parseModelPrices(undefined)).toEqual({});
  });
});

describe("monthOf", () => {
  it("is the UTC calendar month", () => {
    expect(monthOf(new Date("2026-10-31T23:59:59Z"))).toEqual({ from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z", label: "October 2026", key: "2026-10" });
    expect(monthOf(new Date("2026-12-15T00:00:00Z")).to).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("usageLimits", () => {
  const facts = (over: Partial<LimitFacts> = {}): LimitFacts => ({
    mode: "sandbox",
    cyclesToday: 3,
    sandboxCap: 20,
    budget: null,
    service: null,
    invitationsToday: 0,
    invitationCap: 50,
    connectors: [],
    ...over,
  });

  it("says what stops and who acts for each limit, reached ones first", () => {
    const limits = usageLimits(
      facts({
        cyclesToday: 20,
        budget: { remaining: 0, binding: "day", dailyUsdc: 500, weeklyUsdc: null, spentToday: 500, spentThisWeek: 900 },
        connectors: [{ provider: "xero", title: "Xero needs you to reconnect" }],
      })
    );
    expect(limits.map((limit) => [limit.key, limit.state])).toEqual([
      ["sandbox_cycles", "reached"],
      ["agent_budget", "reached"],
      ["connector", "reached"],
      ["invitations", "ok"],
    ]);
    const budget = limits.find((limit) => limit.key === "agent_budget")!;
    expect(budget.used).toBe("500.00 USDC of 500.00 USDC today");
    expect(budget.who).toContain("An owner or admin raises the limit");
    expect(limits.find((limit) => limit.key === "connector")).toMatchObject({ title: "Xero", path: "/settings#xero", who: "An owner or admin reconnects Xero in Settings." });
    expect(limits.find((limit) => limit.key === "sandbox_cycles")!.used).toBe("20 of 20 today");
  });

  it("is near at four fifths, and leaves the sandbox cap out of a live workspace", () => {
    const limits = usageLimits(facts({ mode: "live", invitationsToday: 41 }));
    expect(limits.map((limit) => [limit.key, limit.state])).toEqual([["invitations", "near"]]);
  });

  it("says the Gateway balance stopped payee history checks when it is below one check's price", () => {
    const [service] = usageLimits(facts({ mode: "live", invitationsToday: null, service: { spentToday: 0.01, dailyCapUsdc: 0.05, balanceUsdc: 0.004, maxPriceUsdc: 0.01 } }));
    expect(service).toMatchObject({ key: "service_budget", state: "reached", who: "An owner or admin funds the Gateway balance in Treasury." });
  });

  it("lists a spending limit with no figure as within it", () => {
    const [budget] = usageLimits(facts({ mode: "live", invitationsToday: null, budget: { remaining: Infinity, binding: "day", dailyUsdc: null, weeklyUsdc: null, spentToday: 12, spentThisWeek: 12 } }));
    expect(budget).toMatchObject({ key: "agent_budget", state: "ok", used: "12.00 USDC" });
  });
});
