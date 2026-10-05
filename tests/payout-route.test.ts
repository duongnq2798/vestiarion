import { describe, expect, it } from "vitest";
import { choosePayoutRoute, payoutFundsShort } from "@/lib/payout-route";

/**
 * How a payout to another chain goes, for the agent and a person alike
 * (docs/superpowers/specs/2026-10-05-approval-payout-route-design.md P1, P2). Pure.
 */

const gateway = (feeUsdc: number, balanceUsdc: number) => ({ feeUsdc, balanceUsdc });

describe("choosePayoutRoute", () => {
  it("takes Gateway when its balance covers the amount and its fee, and its fee is no higher than CCTP's", () => {
    expect(choosePayoutRoute({ amount: 2, pinned: null, cctpFeeUsdc: 0.227, gateway: gateway(0.163, 7.89) })).toBe("gateway");
    expect(choosePayoutRoute({ amount: 2, pinned: null, cctpFeeUsdc: 0.163, gateway: gateway(0.163, 2.163) })).toBe("gateway");
  });

  it("takes CCTP when Gateway is short, dearer, or gave no quote", () => {
    expect(choosePayoutRoute({ amount: 2, pinned: null, cctpFeeUsdc: 0.227, gateway: gateway(0.163, 2.1) })).toBe("cctp");
    expect(choosePayoutRoute({ amount: 2, pinned: null, cctpFeeUsdc: 0.1, gateway: gateway(0.163, 7.89) })).toBe("cctp");
    expect(choosePayoutRoute({ amount: 2, pinned: null, cctpFeeUsdc: 0.227, gateway: null })).toBe("cctp");
  });

  it("takes Gateway when CCTP gave no fee and Gateway covers it", () => {
    expect(choosePayoutRoute({ amount: 2, pinned: null, cctpFeeUsdc: null, gateway: gateway(0.163, 7.89) })).toBe("gateway");
  });

  it("keeps the route an earlier attempt took, whatever the figures say now", () => {
    expect(choosePayoutRoute({ amount: 2, pinned: "cctp", cctpFeeUsdc: 0.227, gateway: gateway(0.163, 7.89) })).toBe("cctp");
    expect(choosePayoutRoute({ amount: 2, pinned: "gateway", cctpFeeUsdc: 0.1, gateway: gateway(0.163, 0) })).toBe("gateway");
  });
});

describe("payoutFundsShort", () => {
  it("counts CCTP's fee against the operating wallet, which pays it on top", () => {
    expect(payoutFundsShort({ route: "cctp", amount: 2, operatingUsdc: 2.1, cctpFeeUsdc: 0.227, gateway: null })).toEqual({
      from: "operating",
      holds: 2.1,
      needs: 2.227,
    });
    expect(payoutFundsShort({ route: "cctp", amount: 2, operatingUsdc: 2.3, cctpFeeUsdc: 0.227, gateway: null })).toBeNull();
  });

  it("counts the amount alone when CCTP gave no fee", () => {
    expect(payoutFundsShort({ route: "cctp", amount: 2, operatingUsdc: 2, cctpFeeUsdc: null, gateway: null })).toBeNull();
  });

  it("counts a Gateway payout against the Gateway balance, never the operating wallet", () => {
    expect(payoutFundsShort({ route: "gateway", amount: 2, operatingUsdc: 0, cctpFeeUsdc: 0.227, gateway: gateway(0.163, 7.89) })).toBeNull();
    expect(payoutFundsShort({ route: "gateway", amount: 2, operatingUsdc: 50, cctpFeeUsdc: 0.227, gateway: gateway(0.163, 2) })).toEqual({
      from: "gateway",
      holds: 2,
      needs: 2.163,
    });
  });

  it("counts a Gateway payout with no quote as short, its balance unknown", () => {
    expect(payoutFundsShort({ route: "gateway", amount: 2, operatingUsdc: 50, cctpFeeUsdc: 0.227, gateway: null })).toEqual({
      from: "gateway",
      holds: null,
      needs: null,
    });
  });
});
