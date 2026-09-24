import { describe, expect, it } from "vitest";
import {
  expectedHoldDays,
  planTreasury,
  toUsdc,
  type TreasuryInputs,
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
