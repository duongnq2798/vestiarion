import type { CrossChainRoute } from "./circle/types";

/**
 * How a payout to another chain goes, for the agent and a person's approval alike
 * (docs/superpowers/specs/2026-10-05-approval-payout-route-design.md P1, P2; Gateway payouts G2). Pure: the fees and
 * the Gateway balance are read by the caller, which also knows the route an earlier attempt took.
 */

/** What Circle's Gateway said of a payout: its fee, and the workspace's Gateway balance it would be paid from. */
export interface GatewayFigures {
  feeUsdc: number;
  balanceUsdc: number;
}

const micro = (usdc: number) => Math.round(usdc * 1_000_000);

/**
 * The route a payout takes (P1): the one an earlier attempt took, which every later attempt keeps; otherwise Gateway
 * when its balance covers the amount and its fee, and its fee is no higher than CCTP's (or CCTP gave none); CCTP
 * otherwise.
 */
export function choosePayoutRoute(input: {
  amount: number;
  pinned: CrossChainRoute | null;
  cctpFeeUsdc: number | null;
  gateway: GatewayFigures | null;
}): CrossChainRoute {
  if (input.pinned) return input.pinned;
  const { gateway, cctpFeeUsdc } = input;
  if (gateway === null) return "cctp";
  const covered = micro(gateway.balanceUsdc) >= micro(input.amount + gateway.feeUsdc);
  const noDearer = cctpFeeUsdc === null || micro(gateway.feeUsdc) <= micro(cctpFeeUsdc);
  return covered && noDearer ? "gateway" : "cctp";
}

/**
 * What a payout's route lacks to be paid (P2), or null when it has it. A CCTP payout's amount and fee leave the
 * operating wallet (the amount alone when CCTP gave no fee); a Gateway payout's leave the Gateway balance, and the
 * operating wallet is not touched. A Gateway payout with no quote has a balance no one could read: short, unknown.
 */
export function payoutFundsShort(input: {
  route: CrossChainRoute;
  amount: number;
  operatingUsdc: number;
  cctpFeeUsdc: number | null;
  gateway: GatewayFigures | null;
}): { from: "operating" | "gateway"; holds: number | null; needs: number | null } | null {
  if (input.route === "gateway") {
    if (!input.gateway) return { from: "gateway", holds: null, needs: null };
    const needs = micro(input.amount + input.gateway.feeUsdc) / 1_000_000;
    return micro(input.gateway.balanceUsdc) >= micro(needs) ? null : { from: "gateway", holds: input.gateway.balanceUsdc, needs };
  }
  const needs = micro(input.amount + (input.cctpFeeUsdc ?? 0)) / 1_000_000;
  return micro(input.operatingUsdc) >= micro(needs) ? null : { from: "operating", holds: input.operatingUsdc, needs };
}
