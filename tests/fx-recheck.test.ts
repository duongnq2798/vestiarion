import { describe, expect, it } from "vitest";
import { FX_RECHECK_COOLDOWN_MS, fxChange, fxHoldOf, fxRecheckCandidates, fxRecheckDue, lastFxReopenAt, type FxHold, type FxNow } from "@/lib/fx/recheck";
import { SWAP_COST_CAP_PERCENT } from "@/lib/fx/swap-limits";

/**
 * When a EURC payable held for FX is decided again (docs/superpowers/specs/2026-10-05-fx-reevaluation-design.md): what
 * held it, read from its decision's own ledger entry (F1); the threshold a fresh quote must cross (F2); and the wait
 * after a reopen, so a route that comes and goes cannot loop it (F5). Pure.
 */

/** Loto's 0.5 EURC in demo-wp, held at #1434 because Circle quoted no rate. */
function decision(overrides: Record<string, unknown> = {}, observed: Record<string, unknown> = {}) {
  return {
    seq: 1434,
    detail: {
      invoiceId: "f30819e2",
      decision: { action: "hold", reasoning: "No rate, so it cannot be weighed against the limit." },
      guardrailBlocked: false,
      guardrailRule: null,
      observed: { amount: 0.5, paymentLimit: 1, riskLevel: "clear", poReference: "PO-SWAP-1", goodsReceived: true, ...observed },
      usdcValue: null,
      fx: null,
      eurcBalance: 0,
      swapOffer: null,
      swapUnavailable: null,
      execution: { txRef: null, resultingStatus: "held" },
      ...overrides,
    },
  };
}

const RATE = { rate: 1.215262, source: "circle-stablecoin-quote", quotedAt: "2026-10-05T01:38:20.000Z", usdcMinimum: 0.589402 };
const offer = (costPercent: number) => ({ usdcIn: 0.627, eurcEstimated: 0.51, eurcMinimum: 0.5, usdcPerEurc: 1.215262, costPercent, provider: "lifi" });

describe("fxHoldOf: what held a EURC payable, from its decision's ledger entry (F1)", () => {
  it("reads a payable decided with no rate as held for one", () => {
    expect(fxHoldOf(decision())).toEqual({
      blocker: "no_rate",
      decisionSeq: 1434,
      action: "hold",
      guardrailRule: null,
      amount: 0.5,
      rate: null,
      usdcValue: null,
      swapCostPercent: null,
      eurcShort: 0.5,
    });
  });

  it("reads the code's own refusal for want of a rate the same way", () => {
    const refused = decision({ decision: { action: "pay" }, guardrailBlocked: true, guardrailRule: "fx.rate_unavailable" });
    expect(fxHoldOf(refused)).toMatchObject({ blocker: "no_rate", action: "pay", guardrailRule: "fx.rate_unavailable" });
  });

  it("reads a value above the limit at the quoted rate", () => {
    const over = decision(
      { decision: { action: "pay" }, guardrailBlocked: true, guardrailRule: "counterparty.payment_limit", fx: RATE, usdcValue: 2.310316 },
      { amount: 1.9, paymentLimit: 2 }
    );
    expect(fxHoldOf(over)).toMatchObject({ blocker: "over_limit", rate: 1.215262, usdcValue: 2.310316, guardrailRule: "counterparty.payment_limit" });
  });

  it("reads a swap that cost more than the cap", () => {
    const costly = decision({ fx: RATE, usdcValue: 0.607631, swapOffer: offer(SWAP_COST_CAP_PERCENT + 0.4) });
    expect(fxHoldOf(costly)).toMatchObject({ blocker: "swap_cost", swapCostPercent: 3.4, eurcShort: 0.5 });
  });

  it("reads a swap Circle could not quote, for want of a route, an answer or a minimum", () => {
    for (const reason of [
      "No USDC→EURC route on Arc testnet right now.",
      "Circle's Stablecoin Service did not answer for a USDC→EURC quote.",
      "The USDC→EURC quote could not be read.",
      "The USDC→EURC swap could not be quoted.",
      "The swap's minimum, 0.41 EURC, would not cover the 0.5 EURC needed.",
    ]) {
      expect(fxHoldOf(decision({ fx: RATE, usdcValue: 0.607631, swapUnavailable: reason })), reason).toMatchObject({ blocker: "no_swap", eurcShort: 0.5 });
    }
  });

  it("does not read a swap refused because the payment already started as an FX hold", () => {
    const started = decision({ fx: RATE, usdcValue: 0.607631, swapUnavailable: "A payment for this invoice has already started, so no swap is made for it." });
    expect(fxHoldOf(started)).toBeNull();
  });

  it("does not read a model's own hold with a rate, a usable swap and a value within the limit as an FX hold", () => {
    expect(fxHoldOf(decision({ fx: RATE, usdcValue: 0.607631, swapOffer: offer(1.2) }))).toBeNull();
  });

  it("reads nothing for a payable that was not held, a USDC payable, or one another rule held", () => {
    expect(fxHoldOf(decision({ execution: { txRef: "0xabc", resultingStatus: "paid" } }))).toBeNull();
    const usdc = decision();
    delete (usdc.detail as Record<string, unknown>).fx;
    expect(fxHoldOf(usdc)).toBeNull();
    for (const rule of ["counterparty.high_risk", "counterparty.address_unconfirmed", "invoice.duplicate_of_settled", "workspace.outflow_budget", "fx.swap_usdc_short"]) {
      expect(fxHoldOf(decision({ guardrailBlocked: true, guardrailRule: rule })), rule).toBeNull();
    }
  });

  it("cannot size a swap without the wallet's EURC, as in a sandbox, so does not read one held for it", () => {
    expect(fxHoldOf(decision({ fx: RATE, usdcValue: 0.607631, eurcBalance: null, swapUnavailable: "No USDC→EURC route on Arc testnet right now." }))).toBeNull();
  });
});

const hold = (overrides: Partial<FxHold>): FxHold => ({
  blocker: "no_rate",
  decisionSeq: 1434,
  action: "hold",
  guardrailRule: null,
  amount: 0.5,
  rate: null,
  usdcValue: null,
  swapCostPercent: null,
  eurcShort: 0.5,
  ...overrides,
});
const now = (overrides: Partial<FxNow>): FxNow => ({ rate: null, usdcValue: null, swapCostPercent: null, swapAvailable: null, quotedAt: "2026-10-05T02:00:00.000Z", ...overrides });

describe("fxChange: the threshold a fresh quote must cross (F2)", () => {
  it("clears a hold for want of a rate once one is quoted, saying both", () => {
    expect(fxChange(hold({}), now({ rate: 1.215262, usdcValue: 0.607631 }), 1)).toEqual({
      trigger: "rate_available",
      sentence: "a EURC rate is quoted again: 0.5 EURC is worth 0.607631 USDC at 1.215262 USDC per EURC, where there was none at the decision",
      before: { rate: null, usdcValue: null, swapCostPercent: null },
      after: { rate: 1.215262, usdcValue: 0.607631, swapCostPercent: null, quotedAt: "2026-10-05T02:00:00.000Z" },
    });
    expect(fxChange(hold({}), now({}), 1)).toBeNull();
  });

  it("clears a value above the limit only once the new rate brings it within the current limit", () => {
    const over = hold({ blocker: "over_limit", amount: 1.9, rate: 1.215956, usdcValue: 2.310316 });
    expect(fxChange(over, now({ rate: 1.05, usdcValue: 1.995 }), 2)).toMatchObject({
      trigger: "value_within_limit",
      sentence: "at the new rate 1.9 EURC is worth 1.995 USDC, within the 2 USDC limit, where it was 2.310316 USDC at the decision",
    });
    expect(fxChange(over, now({ rate: 1.2, usdcValue: 2.28 }), 2)).toBeNull();
    // The limit as it is now, not as it was: a lower limit keeps it held.
    expect(fxChange(over, now({ rate: 1.05, usdcValue: 1.995 }), 1.5)).toBeNull();
    expect(fxChange(over, now({}), 2)).toBeNull();
  });

  it("clears a swap above the cap only once a swap costs at most the cap", () => {
    const costly = hold({ blocker: "swap_cost", rate: 1.215262, usdcValue: 0.607631, swapCostPercent: 3.4 });
    expect(fxChange(costly, now({ rate: 1.21, usdcValue: 0.605, swapAvailable: true, swapCostPercent: 1.1 }), 1)).toMatchObject({
      trigger: "swap_cost_within_cap",
      sentence: "a USDC→EURC swap now costs 1.1% above the quoted rate, within the 3% cap, where it cost 3.4% at the decision",
    });
    expect(fxChange(costly, now({ rate: 1.21, usdcValue: 0.605, swapAvailable: true, swapCostPercent: 3.01 }), 1)).toBeNull();
  });

  it("clears a swap Circle could not quote once one can be offered within the cap", () => {
    const noSwap = hold({ blocker: "no_swap", rate: 1.215262, usdcValue: 0.607631 });
    expect(fxChange(noSwap, now({ rate: 1.21, usdcValue: 0.605, swapAvailable: true, swapCostPercent: 0.8 }), 1)).toMatchObject({
      trigger: "swap_available",
      sentence: "a USDC→EURC swap is quoted again, at 0.8% above the quoted rate",
    });
    expect(fxChange(noSwap, now({ rate: 1.21, usdcValue: 0.605, swapAvailable: false }), 1)).toBeNull();
    expect(fxChange(noSwap, now({ rate: 1.21, usdcValue: 0.605, swapAvailable: true, swapCostPercent: 4 }), 1)).toBeNull();
  });
});

describe("the wait after a reopen for FX (F5)", () => {
  const at = Date.parse("2026-10-05T02:00:00.000Z");

  it("re-checks a payable never reopened for FX, or reopened 30 minutes ago or more", () => {
    expect(fxRecheckDue(null, at)).toBe(true);
    expect(fxRecheckDue(new Date(at - FX_RECHECK_COOLDOWN_MS).toISOString(), at)).toBe(true);
  });

  it("waits within 30 minutes of the last reopen for FX", () => {
    expect(FX_RECHECK_COOLDOWN_MS).toBe(30 * 60_000);
    expect(fxRecheckDue(new Date(at - 29 * 60_000).toISOString(), at)).toBe(false);
  });

  it("finds the last reopen for FX among an invoice's entries, newest first, ignoring other reopens", () => {
    const entries = [
      { ts: "2026-10-05T01:55:00.000Z", action: "ap_hold", detail: {} },
      { ts: "2026-10-05T01:54:00.000Z", action: "invoice_reopened", detail: { followUp: { changes: ["the limit was raised"] } } },
      { ts: "2026-10-05T01:40:00.000Z", action: "invoice_reopened", detail: { reevaluation: { trigger: "rate_available" } } },
      { ts: "2026-10-05T01:10:00.000Z", action: "invoice_reopened", detail: { reevaluation: { trigger: "swap_available" } } },
    ];
    expect(lastFxReopenAt(entries)).toBe("2026-10-05T01:40:00.000Z");
    expect(lastFxReopenAt(entries.slice(0, 2))).toBeNull();
  });
});

describe("fxRecheckCandidates: which held payables a re-check asks about (F3, F5, F9)", () => {
  const at = Date.parse("2026-10-05T02:00:00.000Z");
  const held = (id: string, decidedAt: string, status = "held") => ({ id, status, decidedAt });
  const entries = (seq: number, extra: Array<{ ts: string; action: string; detail: Record<string, unknown> }> = []) => [
    ...extra,
    { ...decision(), seq, ts: "2026-10-05T01:00:00.000Z", action: "ap_hold" },
  ];

  it("takes the payables a decision held for FX, oldest decided first, up to the bound", () => {
    const rows = [held("b", "2026-10-05T01:30:00.000Z"), held("a", "2026-10-05T01:00:00.000Z"), held("c", "2026-10-05T01:45:00.000Z")];
    const byInvoice = new Map([["a", entries(10)], ["b", entries(11)], ["c", entries(12)]]);
    expect(fxRecheckCandidates(rows, byInvoice, at, 2).map((candidate) => [candidate.id, candidate.hold.decisionSeq])).toEqual([["a", 10], ["b", 11]]);
  });

  it("skips one no longer held, one held for something else, one with no decision, and one reopened for FX within 30 minutes", () => {
    const rows = [held("flagged", "2026-10-05T01:00:00.000Z", "flagged"), held("other", "2026-10-05T01:00:00.000Z"), held("none", "2026-10-05T01:00:00.000Z"), held("recent", "2026-10-05T01:00:00.000Z")];
    const otherRule = [{ ...decision({ guardrailBlocked: true, guardrailRule: "counterparty.high_risk" }), ts: "2026-10-05T01:00:00.000Z", action: "ap_pay" }];
    const reopenedRecently = entries(13, [{ ts: "2026-10-05T01:50:00.000Z", action: "invoice_reopened", detail: { reevaluation: { trigger: "rate_available" } } }]);
    const byInvoice = new Map<string, Array<{ seq?: number; ts: string; action: string; detail: Record<string, unknown> }>>([
      ["flagged", entries(14)],
      ["other", otherRule],
      ["none", []],
      ["recent", reopenedRecently],
    ]);
    expect(fxRecheckCandidates(rows, byInvoice, at, 5)).toEqual([]);
  });
});

