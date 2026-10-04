import { describe, expect, it } from "vitest";
import {
  expectedHoldDays,
  planTreasury,
  toUsdc,
  type TreasuryInputs,
  boundTreasuryDecision,
  sameTreasuryDecision,
  treasuryBounds,
  sweptHoldDays,
  treasuryUserPrompt,
} from "@/lib/agent/treasury";

const base: TreasuryInputs = {
  operatingBalance: 18500,
  reserveBalance: 0,
  apy: 0.045,
  obligationsDue7d: 4000,
  daysUntilNextObligation: 3,
  roundTripCostUsd: 0.02,
};

describe("toUsdc", () => {
  it("truncates at six decimals rather than rounding up", () => {
    expect(toUsdc(1.2345678)).toBe(1.234567);
    expect(toUsdc(1.9999999)).toBe(1.999999);
  });

  it("truncates toward zero for negatives, so a shortfall is never understated", () => {
    expect(toUsdc(-1.2345678)).toBe(-1.234567);
  });
});

describe("expectedHoldDays", () => {
  it("floors at one day — a same-day round trip still costs two transactions", () => {
    expect(expectedHoldDays(0)).toBe(1);
    expect(expectedHoldDays(0.4)).toBe(1);
  });

  it("caps at thirty days, because a longer forecast is not evidence", () => {
    expect(expectedHoldDays(90)).toBe(30);
  });

  it("treats an empty book as the cap, not as forever", () => {
    expect(expectedHoldDays(Number.POSITIVE_INFINITY)).toBe(30);
  });
});

describe("planTreasury — sweeping", () => {
  it("sweeps idle cash when the yield clears the round-trip fee", () => {
    const plan = planTreasury(base);
    // 18500 - 4000*1.15 = 13900 idle; 13900 * 4.5% * 3/365 = ~$5.14 >> $0.02
    expect(plan.decision.action).toBe("sweep_to_usyc");
    expect(plan.decision.amount).toBe(13900);
    expect(plan.projectedYieldUsd).toBeGreaterThan(plan.roundTripCostUsd);
  });

  it("refuses to sweep when the yield does not cover the fee", () => {
    // The live-testnet case: ~30 USDC idle at 4.5% earns fractions of a cent.
    const plan = planTreasury({
      ...base,
      operatingBalance: 31.72,
      obligationsDue7d: 0,
      daysUntilNextObligation: 3,
    });
    expect(plan.decision.action).toBe("hold");
    expect(plan.decision.amount).toBe(0);
    expect(plan.projectedYieldUsd).toBeLessThan(plan.roundTripCostUsd);
    expect(plan.decision.reasoning).toMatch(/cost more than it earns/);
  });

  it("is scale-free: the same book scaled down 1000x flips the decision", () => {
    const big = planTreasury(base);
    const small = planTreasury({
      ...base,
      operatingBalance: base.operatingBalance / 1000,
      obligationsDue7d: base.obligationsDue7d / 1000,
    });
    expect(big.decision.action).toBe("sweep_to_usyc");
    expect(small.decision.action).toBe("hold");
  });

  it("holds when a longer horizon is the only thing that would justify it", () => {
    const short = planTreasury({ ...base, operatingBalance: 4610, daysUntilNextObligation: 1 });
    const long = planTreasury({ ...base, operatingBalance: 4610, daysUntilNextObligation: 30 });
    // 4610 - 4600 = 10 idle. One day: 10*.045/365 = $0.0012 < $0.02. Thirty
    // days: $0.037 > $0.02. Same balance, different answer — which is the point.
    expect(short.decision.action).toBe("hold");
    expect(long.decision.action).toBe("sweep_to_usyc");
  });

  it("cites the numbers it used, so an auditor can re-derive the decision", () => {
    const reasoning = planTreasury(base).decision.reasoning;
    expect(reasoning).toContain("13900");
    expect(reasoning).toContain("4.50%");
    expect(reasoning).toContain("4600");
  });

  it("never sweeps below the buffer", () => {
    const plan = planTreasury(base);
    const left = base.operatingBalance - plan.decision.amount;
    expect(left).toBeGreaterThanOrEqual(plan.buffer);
  });

  it("applies the 15% cushion on top of the obligations themselves", () => {
    expect(planTreasury(base).buffer).toBe(4600);
  });

  it("honours an explicit buffer ratio", () => {
    const plan = planTreasury({ ...base, bufferRatio: 2 });
    expect(plan.buffer).toBe(8000);
    expect(plan.decision.amount).toBe(10500);
  });
});

describe("planTreasury — redeeming", () => {
  it("redeems the shortfall when the buffer is breached", () => {
    const plan = planTreasury({
      ...base,
      operatingBalance: 1000,
      reserveBalance: 9000,
    });
    // Needs 4600, holds 1000 → 3600 short.
    expect(plan.decision).toMatchObject({ action: "redeem_from_usyc", amount: 3600 });
  });

  it("redeems only what the reserve actually holds", () => {
    const plan = planTreasury({
      ...base,
      operatingBalance: 1000,
      reserveBalance: 500,
    });
    expect(plan.decision).toMatchObject({ action: "redeem_from_usyc", amount: 500 });
  });

  it("holds and explains itself when the buffer is breached and the reserve is empty", () => {
    const plan = planTreasury({ ...base, operatingBalance: 1000, reserveBalance: 0 });
    expect(plan.decision.action).toBe("hold");
    expect(plan.decision.reasoning).toMatch(/nothing to redeem/);
  });

  it("redeems ahead of an obligation rather than sweeping into one", () => {
    // Zero days out with cash short: redeeming must win over any yield story.
    const plan = planTreasury({
      ...base,
      operatingBalance: 100,
      reserveBalance: 10000,
      daysUntilNextObligation: 0,
    });
    expect(plan.decision.action).toBe("redeem_from_usyc");
  });
});

describe("planTreasury — edges", () => {
  it("holds on an empty book with an empty wallet", () => {
    const plan = planTreasury({
      operatingBalance: 0,
      reserveBalance: 0,
      apy: 0.045,
      obligationsDue7d: 0,
      daysUntilNextObligation: Number.POSITIVE_INFINITY,
      roundTripCostUsd: 0.02,
    });
    expect(plan.decision).toMatchObject({ action: "hold", amount: 0 });
  });

  it("never sweeps at zero APY, however much cash is idle", () => {
    const plan = planTreasury({ ...base, apy: 0 });
    expect(plan.decision.action).toBe("hold");
    expect(plan.projectedYieldUsd).toBe(0);
  });

  it("sweeps less when the chain is more expensive", () => {
    const cheap = planTreasury({ ...base, operatingBalance: 4610, daysUntilNextObligation: 30 });
    const dear = planTreasury({
      ...base,
      operatingBalance: 4610,
      daysUntilNextObligation: 30,
      roundTripCostUsd: 5,
    });
    expect(cheap.decision.action).toBe("sweep_to_usyc");
    expect(dear.decision.action).toBe("hold");
  });

  it("returns an amount that is always a valid USDC quantity", () => {
    const plan = planTreasury({ ...base, operatingBalance: 18500.123456789 });
    expect(plan.decision.amount).toBe(toUsdc(plan.decision.amount));
  });
});

describe("code's bounds on the treasury's move (treasury bounds R1–R4)", () => {
  // testnet-2 at 07:43 UTC on Oct 3 (#1063): nothing in operating, 58.21 USDC in the reserve, 0.1 USDC due within 7 and 14 days.
  const plan = planTreasury({ operatingBalance: 0, reserveBalance: 58.210738, apy: 0.0345, obligationsDue7d: 0.1, daysUntilNextObligation: 1.68, roundTripCostUsd: 0.00638 });
  const facts = { operatingBalance: 0, reserveBalance: 58.210738, obligationsDue14d: 0.1, plan, reference: plan.decision };
  const move = (action: "sweep_to_usyc" | "redeem_from_usyc" | "hold", amount: number) => ({ action, amount, reasoning: "The model's reasons." });

  it("brings a redemption of the whole reserve down to what the next 14 days need, and says why", () => {
    expect(plan.decision).toMatchObject({ action: "redeem_from_usyc", amount: 0.114999 });
    const bounded = boundTreasuryDecision(move("redeem_from_usyc", 58.1), facts);
    expect(bounded.decision).toMatchObject({ action: "redeem_from_usyc", amount: 0.114999 });
    expect(bounded.limited).toBe("58.1 USDC is more than the 0.114999 USDC what falls due within 14 days needs, with its cushion, so 0.114999 USDC was redeemed");
    expect(bounded.decision.reasoning).toBe("The model's reasons. [Code limited this: 58.1 USDC is more than the 0.114999 USDC what falls due within 14 days needs, with its cushion, so 0.114999 USDC was redeemed.]");
  });

  it("raises a redemption that would leave the buffer short to the written policy's", () => {
    expect(boundTreasuryDecision(move("redeem_from_usyc", 0.05), facts)).toMatchObject({ decision: { action: "redeem_from_usyc", amount: 0.114999 } });
  });

  it("redeems nothing that nothing due needs", () => {
    const idle = planTreasury({ operatingBalance: 50, reserveBalance: 20, apy: 0.0345, obligationsDue7d: 1, daysUntilNextObligation: 3, roundTripCostUsd: 0.00638 });
    expect(boundTreasuryDecision(move("redeem_from_usyc", 5), { operatingBalance: 50, reserveBalance: 20, obligationsDue14d: 1, plan: idle, reference: idle.decision })).toMatchObject({
      decision: { action: "hold", amount: 0 },
      limited: "nothing falling due within 14 days needs cash from the reserve, so nothing was redeemed",
    });
  });

  it("sweeps only what sits above the buffer, and nothing when the buffer is short", () => {
    const flush = planTreasury({ operatingBalance: 100, reserveBalance: 0, apy: 0.0345, obligationsDue7d: 10, daysUntilNextObligation: 20, roundTripCostUsd: 0.00638 });
    const flushFacts = { operatingBalance: 100, reserveBalance: 0, obligationsDue14d: 10, plan: flush, reference: flush.decision };
    expect(boundTreasuryDecision(move("sweep_to_usyc", 100), flushFacts)).toMatchObject({ decision: { action: "sweep_to_usyc", amount: 88.5 } });
    expect(boundTreasuryDecision(move("sweep_to_usyc", 50), flushFacts)).toMatchObject({ decision: { action: "sweep_to_usyc", amount: 50 }, limited: null });
    expect(boundTreasuryDecision(move("sweep_to_usyc", 1), facts)).toMatchObject({ decision: { action: "hold", amount: 0 } });
  });

  it("leaves a hold, and a move within bounds, as the model made it", () => {
    expect(boundTreasuryDecision(move("hold", 0), facts)).toEqual({ decision: move("hold", 0), limited: null });
    expect(boundTreasuryDecision(move("redeem_from_usyc", 0.114999), facts)).toEqual({ decision: move("redeem_from_usyc", 0.114999), limited: null });
  });

  it("tells the model the bounds it is held to", () => {
    expect(treasuryBounds(facts)).toEqual({ sweepAtMost: 0, redeemAtMost: 0.114999, redeemAtLeast: 0.114999 });
  });

  it("counts a decision as the policy's only when its amount is about the policy's too", () => {
    expect(sameTreasuryDecision(move("redeem_from_usyc", 58.1), plan.decision)).toBe(false);
    expect(sameTreasuryDecision(move("redeem_from_usyc", 0.115), plan.decision)).toBe(true);
    expect(sameTreasuryDecision(move("redeem_from_usyc", 10.4), move("redeem_from_usyc", 10))).toBe(true);
    expect(sameTreasuryDecision(move("redeem_from_usyc", 10.6), move("redeem_from_usyc", 10))).toBe(false);
    expect(sameTreasuryDecision(move("hold", 0), move("hold", 0))).toBe(true);
    expect(sameTreasuryDecision(move("hold", 0), plan.decision)).toBe(false);
  });
});

describe("how long swept cash would stay (treasury hold horizon R1–R2)", () => {
  it("stays the whole 30 days when nothing within them calls it back", () => {
    expect(sweptHoldDays(100, 110, [])).toBe(30);
    expect(sweptHoldDays(100, 110, [{ days: 45, amount: 500 }])).toBe(30);
    // What the operating wallet keeps pays what falls due first: the 7-day buffer covers it.
    expect(sweptHoldDays(118.585001, 118.7, [{ days: 1.64, amount: 0.1 }])).toBe(30);
  });

  it("comes back, in part, on the day the operating wallet cannot cover what falls due", () => {
    // Half the sweep comes back on day 10; the other half stays 30 days: 20 days on average.
    expect(sweptHoldDays(100, 100, [{ days: 10, amount: 50 }])).toBe(20);
    // The operating wallet's 10 pays the first 10 of the 60 due on day 6, the sweep the other 50.
    expect(sweptHoldDays(100, 110, [{ days: 6, amount: 60 }])).toBe(18);
  });

  it("is at least a day, however soon it is all called back", () => {
    expect(sweptHoldDays(10, 10, [{ days: 0, amount: 25 }])).toBe(1);
  });
});

describe("planTreasury with what falls due, each on its day (hold horizon R1, R3)", () => {
  // testnet-2 at 08:31 UTC on Oct 3 (#1103): 118.7 USDC in operating, 0.1 USDC due in 1.64 days, nothing after.
  const now = { operatingBalance: 118.7, reserveBalance: 0.110738, apy: 0.0345, obligationsDue7d: 0.1, daysUntilNextObligation: 1.64, roundTripCostUsd: 0.00638 };

  it("weighs a month of yield on cash nothing will call back, where the next obligation's horizon counted under two days", () => {
    // Before: the whole sweep was assumed back in 1.64 days, so the yield weighed was under 2 cents.
    expect(planTreasury(now)).toMatchObject({ holdDays: 1.64, projectedYieldUsd: 0.018382 });
    const plan = planTreasury({ ...now, obligationSchedule: [{ days: 1.64, amount: 0.1 }] });
    expect(plan.holdDays).toBe(30);
    expect(plan.projectedYieldUsd).toBe(0.336261);
    expect(plan.decision).toMatchObject({ action: "sweep_to_usyc", amount: 118.585001 });
    expect(plan.decision.reasoning).toContain("over the 30 days the swept cash would stay, on average, before what falls due calls it back, that earns about $0.3363");
  });

  it("still holds a sweep too small to pay for its transfers", () => {
    const plan = planTreasury({ ...now, operatingBalance: 2.1, obligationSchedule: [{ days: 1.64, amount: 0.1 }] });
    expect(plan.decision.action).toBe("hold");
    expect(plan.decision.reasoning).toContain("over the 30 days the swept cash would stay");
  });
});

describe("what the treasury model is told (treasury cash facts)", () => {
  // testnet-2, 2026-10-04 02:42 UTC, ledger #1267: the wallet held 0 USDC, the reserve 134.72, and 0.20 fell due that
  // day. The model held, reasoning that "the reserve already covers it without moving cash".
  const plan = planTreasury({ operatingBalance: 0, reserveBalance: 134.718108, apy: 0.0345, obligationsDue7d: 0.2, daysUntilNextObligation: 0, roundTripCostUsd: 0.00638 });
  const facts = {
    operatingBalance: 0,
    reserveBalance: 134.718108,
    apy: 0.0345,
    obligationsDue7d: 0.2,
    obligationsDue14d: 0.2,
    obligationsOpenTotal: 0.2,
    daysUntilNextObligation: 0,
    plan,
    usyc: { subscriptionsOpen: true },
    bounds: { sweepAtMost: 0, redeemAtMost: 0.23, redeemAtLeast: 0.23 },
  };

  it("says the reserve pays no one: every payment leaves from the operating wallet, and what is due that day comes back first", () => {
    const { payments } = JSON.parse(treasuryUserPrompt(facts));
    expect(payments.note).toContain("Every payment leaves from the operating wallet");
    expect(payments.note).toContain("the reserve pays no one");
    expect(payments.note).toContain("before it decides any payment");
  });

  it("hands over the figures and bounds the model weighs, and USYC's window only for a real reserve", () => {
    expect(JSON.parse(treasuryUserPrompt(facts))).toMatchObject({
      operatingBalance: 0,
      reserveBalance: 134.718108,
      reserveApy: 0.0345,
      upcomingObligationsNext7Days: 0.2,
      upcomingObligationsNext14Days: 0.2,
      totalOpenObligations: 0.2,
      daysUntilNextObligation: 0,
      economics: { idleAboveBuffer: plan.idle, requiredBuffer: plan.buffer, expectedHoldDays: plan.holdDays },
      usyc: { reserveIsRealUsyc: true, subscriptionsOpen: true },
      bounds: { sweepAtMostUsdc: 0, redeemAtMostUsdc: 0.23, redeemAtLeastUsdc: 0.23 },
      responseShape: { action: "sweep_to_usyc | redeem_from_usyc | hold" },
    });
    expect(JSON.parse(treasuryUserPrompt({ ...facts, usyc: null })).usyc).toBeUndefined();
    expect(JSON.parse(treasuryUserPrompt({ ...facts, daysUntilNextObligation: Infinity })).daysUntilNextObligation).toBeNull();
  });
});
