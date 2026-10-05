import { describe, expect, it } from "vitest";
import { enforceApGuardrails } from "@/lib/agent/guardrails";
import type { DuplicateMatch } from "@/lib/agent/duplicates";
import type { BudgetRoom } from "@/lib/agent/outflow-budget";

describe("AP execution guardrails", () => {
  it("refuses a model pay verdict above a screened-down limit", () => {
    const result = enforceApGuardrails({
      action: "pay",
      reasoning: "The model recommends paying because the invoice evidence matches.",
      amount: 0.9,
      riskLevel: "medium",
      paymentLimit: 0.5,
    });
    expect(result).toMatchObject({
      blocked: true,
      status: "held",
      rule: "counterparty.payment_limit",
    });
    expect(result.reasoning).toContain("refused before execution");
  });

  it("gives high risk precedence even when the amount also exceeds the limit", () => {
    expect(enforceApGuardrails({
      action: "pay",
      reasoning: "Pay now.",
      amount: 10,
      riskLevel: "high",
      paymentLimit: 0,
    })).toMatchObject({ blocked: true, status: "flagged", rule: "counterparty.high_risk" });
  });

  it("does not rewrite a non-payment model verdict", () => {
    expect(enforceApGuardrails({
      action: "hold",
      reasoning: "Hold for review.",
      amount: 10,
      riskLevel: "high",
      paymentLimit: 0,
    })).toEqual({ blocked: false, status: null, rule: null, reasoning: "Hold for review." });
  });
});

describe("AP guardrails — duplicate billing", () => {
  const settledTwin: DuplicateMatch = {
    otherId: "inv-old",
    otherStatus: "paid",
    otherDueDate: "2026-09-27T00:00:00.000Z",
    otherAmount: 240,
    confidence: 0.95,
    signals: ["same_purchase_order", "same_amount"],
    explanation: "Bills the same purchase order for the same 240 USDC as invoice due 2026-09-27 (already paid).",
    againstSettled: true,
  };

  const clean = {
    action: "pay" as const,
    reasoning: "PO matches, goods received, counterparty clear, amount within limit.",
    amount: 240,
    riskLevel: "clear",
    paymentLimit: 2000,
  };

  it("refuses a pay verdict that repeats an already-settled invoice", () => {
    // Every other check passes, and that is the point: the counterparty is
    // clear, the amount is within its limit and the three-way match is
    // complete — because all of that was true the first time the bill was paid.
    const result = enforceApGuardrails({ ...clean, duplicates: [settledTwin] });
    expect(result).toMatchObject({
      blocked: true,
      status: "flagged",
      rule: "invoice.duplicate_of_settled",
    });
    expect(result.reasoning).toContain("refused before execution");
    expect(result.reasoning).toContain("same purchase order");
  });

  it("names the duplicate ahead of risk when both would block", () => {
    // The reported rule is what a reviewer acts on. A repeat of settled money
    // needs a different response from a sanctions hit, so the more specific
    // finding has to survive.
    const result = enforceApGuardrails({
      ...clean,
      riskLevel: "high",
      duplicates: [settledTwin],
    });
    expect(result.rule).toBe("invoice.duplicate_of_settled");
  });

  it("does not block on a repeat of an invoice that is still unpaid", () => {
    // Worth raising with a human, but nothing has left the account, so code
    // does not overrule the model on its own authority.
    const result = enforceApGuardrails({
      ...clean,
      duplicates: [{ ...settledTwin, otherStatus: "pending", againstSettled: false, confidence: 0.85 }],
    });
    expect(result.blocked).toBe(false);
  });

  it("does not block on a weak resemblance", () => {
    const result = enforceApGuardrails({
      ...clean,
      duplicates: [{ ...settledTwin, confidence: 0.55, signals: ["purchase_order_rebilled"] }],
    });
    expect(result.blocked).toBe(false);
  });

  it("leaves a clean invoice alone when nothing matched", () => {
    expect(enforceApGuardrails({ ...clean, duplicates: [] }).blocked).toBe(false);
    expect(enforceApGuardrails(clean).blocked).toBe(false);
  });

  it("does not manufacture a block when the model already refused", () => {
    // A guardrail overrides a "pay"; it must not rewrite a verdict that
    // already declined, or the ledger would credit code for the model's call.
    const result = enforceApGuardrails({
      ...clean,
      action: "flag_fraud",
      duplicates: [settledTwin],
    });
    expect(result.blocked).toBe(false);
    expect(result.reasoning).toBe(clean.reasoning);
  });
});

describe("AP guardrails — a changed address no one has confirmed", () => {
  const base = { action: "pay" as const, reasoning: "Pay now.", amount: 2, riskLevel: "clear", paymentLimit: 5 };

  it("holds a pay verdict while the address change is unconfirmed, naming the date", () => {
    const result = enforceApGuardrails({ ...base, addressChangedAt: "2026-09-30T12:00:00Z", addressConfirmedAt: null });
    expect(result).toMatchObject({ blocked: true, status: "held", rule: "counterparty.address_unconfirmed" });
    expect(result.reasoning).toBe(
      "Pay now. [guardrail override: the counterparty's address changed on 2026-09-30 and no one has confirmed it — held for a person to approve]"
    );
  });

  it("holds when the last confirmation predates the change", () => {
    expect(
      enforceApGuardrails({ ...base, addressChangedAt: "2026-09-30T12:00:00Z", addressConfirmedAt: "2026-09-29T12:00:00Z" })
    ).toMatchObject({ blocked: true, rule: "counterparty.address_unconfirmed" });
  });

  it("pays once a person confirmed the new address", () => {
    expect(
      enforceApGuardrails({ ...base, addressChangedAt: "2026-09-30T12:00:00Z", addressConfirmedAt: "2026-09-30T12:05:00Z" })
    ).toEqual({ blocked: false, status: null, rule: null, reasoning: "Pay now." });
  });

  it("never holds an address set when the counterparty was added", () => {
    expect(enforceApGuardrails({ ...base, addressChangedAt: null, addressConfirmedAt: null })).toMatchObject({ blocked: false });
    expect(enforceApGuardrails(base)).toMatchObject({ blocked: false });
  });

  it("still flags high risk first", () => {
    expect(
      enforceApGuardrails({ ...base, riskLevel: "high", addressChangedAt: "2026-09-30T12:00:00Z", addressConfirmedAt: null })
    ).toMatchObject({ status: "flagged", rule: "counterparty.high_risk" });
  });

  it("names the address change ahead of the limit when both would hold", () => {
    expect(
      enforceApGuardrails({ ...base, amount: 50, addressChangedAt: "2026-09-30T12:00:00Z", addressConfirmedAt: null })
    ).toMatchObject({ status: "held", rule: "counterparty.address_unconfirmed" });
  });

  it("leaves a non-payment verdict alone", () => {
    expect(
      enforceApGuardrails({ ...base, action: "hold", addressChangedAt: "2026-09-30T12:00:00Z", addressConfirmedAt: null })
    ).toEqual({ blocked: false, status: null, rule: null, reasoning: "Pay now." });
  });
});

describe("AP guardrails — schedule is bound exactly like pay", () => {
  const settledTwin: DuplicateMatch = {
    otherId: "inv-old",
    otherStatus: "paid",
    otherDueDate: "2026-09-27T00:00:00.000Z",
    otherAmount: 240,
    confidence: 0.95,
    signals: ["same_purchase_order", "same_amount"],
    explanation: "Bills the same purchase order for the same 240 USDC as invoice due 2026-09-27 (already paid).",
    againstSettled: true,
  };

  it("refuses a schedule verdict above a screened-down limit, same rule id as pay", () => {
    const result = enforceApGuardrails({
      action: "schedule",
      reasoning: "The model recommends scheduling for the discount deadline.",
      amount: 0.9,
      riskLevel: "medium",
      paymentLimit: 0.5,
    });
    expect(result).toMatchObject({
      blocked: true,
      status: "held",
      rule: "counterparty.payment_limit",
    });
    expect(result.reasoning).toContain("scheduling refused before execution");
  });

  it("refuses a schedule verdict for a high-risk counterparty", () => {
    const result = enforceApGuardrails({
      action: "schedule",
      reasoning: "Schedule for the deadline.",
      amount: 10,
      riskLevel: "high",
      paymentLimit: 0,
    });
    expect(result).toMatchObject({ blocked: true, status: "flagged", rule: "counterparty.high_risk" });
    expect(result.reasoning).toContain("scheduling refused before execution");
  });

  it("refuses a schedule verdict that repeats an already-settled invoice", () => {
    const result = enforceApGuardrails({
      action: "schedule",
      reasoning: "PO matches, goods received, counterparty clear, amount within limit.",
      amount: 240,
      riskLevel: "clear",
      paymentLimit: 2000,
      duplicates: [settledTwin],
    });
    expect(result).toMatchObject({ blocked: true, status: "flagged", rule: "invoice.duplicate_of_settled" });
    expect(result.reasoning).toContain("scheduling refused before execution");
  });

  it("holds a schedule verdict while the counterparty's address change is unconfirmed", () => {
    const result = enforceApGuardrails({
      action: "schedule",
      reasoning: "Schedule for the deadline.",
      amount: 2,
      riskLevel: "clear",
      paymentLimit: 5,
      addressChangedAt: "2026-09-30T12:00:00Z",
      addressConfirmedAt: null,
    });
    expect(result).toMatchObject({ blocked: true, status: "held", rule: "counterparty.address_unconfirmed" });
    // Unlike the "refused" rules, this reasoning was never "payment"-specific, and stays as-is.
    expect(result.reasoning).toContain("held for a person to approve");
  });

  it("leaves a clean schedule verdict alone", () => {
    const result = enforceApGuardrails({
      action: "schedule",
      reasoning: "Schedule for the deadline.",
      amount: 10,
      riskLevel: "clear",
      paymentLimit: 100,
    });
    expect(result).toEqual({ blocked: false, status: null, rule: null, reasoning: "Schedule for the deadline." });
  });
});

describe("a EURC payment the wallet is short of, and the swap that could fund it (EURC swap spec S5)", () => {
  const OFFER = { usdcIn: 2.507384, costPercent: 0.09 };
  const base = {
    action: "pay" as const,
    reasoning: "Pay now, swapping USDC for the EURC it needs.",
    amount: 2.43,
    riskLevel: "clear",
    paymentLimit: 10,
    currency: "EURC" as const,
    fxAvailable: true,
  };
  type SwapFacts = { requested: boolean; offer: { usdcIn: number; costPercent: number } | null; usdcBalance: number; usdcDueWithin7Days: number };
  const short = (swap: SwapFacts) => ({ balance: 0, needed: 2, swap });
  const swap = (overrides: Partial<SwapFacts> = {}): SwapFacts => ({ requested: true, offer: OFFER, usdcBalance: 20, usdcDueWithin7Days: 5, ...overrides });

  it("lets a payment through that the model chose to fund with the offered swap", () => {
    expect(enforceApGuardrails({ ...base, eurcShort: short(swap()) })).toEqual({ blocked: false, status: null, rule: null, reasoning: base.reasoning });
  });

  it("holds one the model did not choose to fund with a swap, as before", () => {
    const result = enforceApGuardrails({ ...base, eurcShort: short(swap({ requested: false })) });
    expect(result).toMatchObject({ blocked: true, status: "held", rule: "treasury.insufficient_eurc" });
    expect(result.reasoning).toContain("holds 0 EURC, less than the 2 EURC");
  });

  it("holds one the model would fund with a swap when there was none to make", () => {
    const result = enforceApGuardrails({ ...base, eurcShort: short(swap({ offer: null })) });
    expect(result).toMatchObject({ blocked: true, status: "held", rule: "treasury.insufficient_eurc" });
    expect(result.reasoning).toContain("no swap was available");
  });

  it("holds a swap that costs more than 3% above the rate the payable was weighed at", () => {
    const result = enforceApGuardrails({ ...base, eurcShort: short(swap({ offer: { usdcIn: 2.6, costPercent: 3.2 } })) });
    expect(result).toMatchObject({ blocked: true, status: "held", rule: "fx.swap_cost_above_cap" });
    expect(result.reasoning).toContain("3.2%");
  });

  it("holds a swap that would leave the USDC short of what falls due in USDC within 7 days", () => {
    const result = enforceApGuardrails({ ...base, eurcShort: short(swap({ usdcBalance: 7, usdcDueWithin7Days: 5 })) });
    expect(result).toMatchObject({ blocked: true, status: "held", rule: "fx.swap_usdc_short" });
    expect(result.reasoning).toContain("4.492616 USDC");
  });

  it("still holds a payment whose EURC could not be read, swap or not", () => {
    const result = enforceApGuardrails({ ...base, eurcShort: { balance: null, needed: 2, swap: swap() } });
    expect(result).toMatchObject({ blocked: true, rule: "treasury.insufficient_eurc" });
  });
});

describe("the agent's spending limit (outflow budget R4)", () => {
  const room = (overrides: Partial<BudgetRoom> = {}): BudgetRoom => ({
    dailyUsdc: 100, weeklyUsdc: 300, spentToday: 80, spentThisWeek: 120, remaining: 20, binding: "day", ...overrides,
  });
  const base = { action: "pay" as const, reasoning: "Pay now.", amount: 25, riskLevel: "clear", paymentLimit: 50 };

  it("holds a payment that would take the agent past what the day leaves, naming what was paid", () => {
    const result = enforceApGuardrails({ ...base, outflowBudget: room() });
    expect(result).toMatchObject({ blocked: true, status: "held", rule: "workspace.outflow_budget" });
    expect(result.reasoning).toContain("25 USDC would take the agent past its 100 USDC daily spending limit: 80 USDC already paid today, 20 USDC left");
    expect(result.reasoning).toContain("held for a person to approve");
  });

  it("names the 7-day figure when that is the one that stops it", () => {
    const result = enforceApGuardrails({ ...base, outflowBudget: room({ spentToday: 0, spentThisWeek: 290, remaining: 10, binding: "week" }) });
    expect(result.reasoning).toContain("past its 300 USDC 7-day spending limit: 290 USDC already paid in the last 7 days, 10 USDC left");
  });

  it("lets through a payment that fits exactly, and any payment with no limit set", () => {
    expect(enforceApGuardrails({ ...base, amount: 20, outflowBudget: room() }).blocked).toBe(false);
    expect(enforceApGuardrails({ ...base, outflowBudget: null }).blocked).toBe(false);
  });

  it("does not hold a schedule: the payable is decided again on its day", () => {
    expect(enforceApGuardrails({ ...base, action: "schedule", outflowBudget: room({ remaining: 0 }) }).blocked).toBe(false);
  });

  it("names a counterparty's own limit first, and holds before any EURC swap is made", () => {
    expect(enforceApGuardrails({ ...base, amount: 60, outflowBudget: room() }).rule).toBe("counterparty.payment_limit");
    const swap = { requested: true, offer: { usdcIn: 26, costPercent: 0.1 }, usdcBalance: 200, usdcDueWithin7Days: 0 };
    const result = enforceApGuardrails({ ...base, currency: "EURC", fxAvailable: true, eurcShort: { balance: 0, needed: 22, swap }, outflowBudget: room() });
    expect(result.rule).toBe("workspace.outflow_budget");
  });
});

describe("AP guardrails — the three-way match (three-way match design M1, M3)", () => {
  const base = { reasoning: "Pay it.", amount: 0.5, riskLevel: "clear", paymentLimit: 5 } as const;
  const match = (poReference: string | null, goodsReceived: boolean, purchaseOrderRequired = true) => ({ poReference, goodsReceived, purchaseOrderRequired });

  it("refuses a payment with no purchase order when the counterparty needs one, and asks for information", () => {
    const result = enforceApGuardrails({ ...base, action: "pay", match: match(null, true) });
    expect(result).toMatchObject({ blocked: true, status: "awaiting_info", rule: "invoice.match_incomplete" });
    expect(result.reasoning).toContain("no purchase order is on file");
    expect(result.reasoning).toContain("payment refused before execution");
  });

  it("refuses a schedule the same way: an incomplete match is never committed to a date either", () => {
    const result = enforceApGuardrails({ ...base, action: "schedule", match: match(null, true) });
    expect(result).toMatchObject({ blocked: true, status: "awaiting_info", rule: "invoice.match_incomplete" });
    expect(result.reasoning).toContain("scheduling refused before execution");
  });

  it("refuses goods not received, whatever the counterparty's purchase orders", () => {
    for (const required of [true, false]) {
      const result = enforceApGuardrails({ ...base, action: "pay", match: match("PO-1", false, required) });
      expect(result).toMatchObject({ blocked: true, status: "awaiting_info", rule: "invoice.match_incomplete" });
      expect(result.reasoning).toContain("the goods are not confirmed received");
    }
  });

  it("lets a complete match through, and one with no purchase order for a counterparty paid without them", () => {
    expect(enforceApGuardrails({ ...base, action: "pay", match: match("PO-1", true) })).toMatchObject({ blocked: false, rule: null });
    expect(enforceApGuardrails({ ...base, action: "pay", match: match(null, true, false) })).toMatchObject({ blocked: false, rule: null });
  });

  it("leaves a hold or a request for information alone", () => {
    for (const action of ["hold", "request_info"] as const) {
      expect(enforceApGuardrails({ ...base, action, match: match(null, false) })).toMatchObject({ blocked: false, status: null });
    }
  });

  it("lets a changed address speak first, and speaks before the limit", () => {
    const address = enforceApGuardrails({ ...base, action: "pay", match: match(null, true), addressChangedAt: "2026-10-05T00:00:00Z", addressConfirmedAt: null });
    expect(address.rule).toBe("counterparty.address_unconfirmed");
    const overLimit = enforceApGuardrails({ ...base, action: "pay", amount: 50, match: match(null, true) });
    expect(overLimit.rule).toBe("invoice.match_incomplete");
  });
});
