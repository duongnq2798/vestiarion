import { describe, expect, it } from "vitest";
import { liveOperatingBalance } from "@/lib/agent/orchestrator";

/**
 * The reconcile stage's arithmetic for the operating account in live mode,
 * while the USYC leg is simulated: the reserve is a notional carve-out of the
 * USDC in the operating wallet. The stage itself runs inside
 * `runAgentCycle()`, which `tests/orchestrator.test.ts` explains is not
 * driven end to end in unit tests, so its one piece of arithmetic is proven
 * here, the way `tests/pause-cycle.test.ts` proves `pausedPaymentNote`.
 */
describe("liveOperatingBalance", () => {
  it("carves the notional reserve out of what is on chain", () => {
    expect(liveOperatingBalance(100, 30)).toEqual({ spendable: 70, reserve: 30 });
  });

  it("never carves out more than exists: a reserve larger than the on-chain balance is clamped to it", () => {
    // A workspace funded with 20 USDC that still carries a 3,000 simulated reserve.
    expect(liveOperatingBalance(20, 3000)).toEqual({ spendable: 0, reserve: 20 });
  });

  it("never lets spendable plus the carve-out differ from the money on chain", () => {
    for (const [onChain, notional] of [[20, 3000], [100, 30], [0, 5], [12.345678, 12.345679]] as const) {
      const { spendable, reserve } = liveOperatingBalance(onChain, notional);
      expect(spendable + reserve).toBeCloseTo(onChain, 6);
      expect(reserve).toBeLessThanOrEqual(onChain);
    }
  });

  it("spends everything on chain when there is no reserve", () => {
    expect(liveOperatingBalance(20, 0)).toEqual({ spendable: 20, reserve: 0 });
  });

  it("treats a negative reserve or balance as none", () => {
    expect(liveOperatingBalance(20, -5)).toEqual({ spendable: 20, reserve: 0 });
    expect(liveOperatingBalance(-1, 5)).toEqual({ spendable: 0, reserve: 0 });
  });
});
