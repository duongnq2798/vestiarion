import { encodeDeployData, encodeFunctionData, getAddress, type Abi, type Hex } from "viem";
import type { NetworkProfile } from "../network";
import artifact from "./artifact.json";

/**
 * Vestiarion's spending limit contract's creation code for a treasury, its agent and its figures: what a wallet sends to
 * deploy it, directly or through the deterministic deployment proxy, and what a creation call is simulated with to
 * check a deployment (wallet treasury W6, W8; passkey treasury K6). Both versions (docs/superpowers/specs/2026-10-19-
 * spending-limit-v2-cross-chain-design.md V7): version 2 also names the token messenger it burns through and the CCTP
 * domains it may burn for. Browser-safe: viem, the network profile's data and the compiled artifact only.
 */

export type SpendingLimitVersion = 1 | 2;

export const SPENDING_LIMIT_ARTIFACTS: Record<SpendingLimitVersion, { abi: Abi; bytecode: Hex }> = {
  1: { abi: artifact.v1.abi as Abi, bytecode: artifact.v1.bytecode as Hex },
  2: { abi: artifact.v2.abi as Abi, bytecode: artifact.v2.bytecode as Hex },
};

/** What version 2 is deployed with on a network (V3): TokenMessengerV2, and its allowed CCTP domains as a bitmask. */
export interface SpendingLimitTerms {
  tokenMessenger: string;
  allowedDomains: bigint;
}

/** The most `maxFee` may be in `payAcrossChains` (V4): 10% of the amount, and never above 2 USDC. */
export const MAX_FEE_BPS = 1000n;
export const MAX_FEE_UNITS = 2_000_000n;

/** The fee cap version 2 holds a payout of `amountUnits` to, in units: what `payAcrossChains` refuses above. */
export function feeCapUnits(amountUnits: bigint): bigint {
  const share = (amountUnits * MAX_FEE_BPS) / 10_000n;
  return share < MAX_FEE_UNITS ? share : MAX_FEE_UNITS;
}

/**
 * The terms a network deploys version 2 with (V3, V8): its CCTP TokenMessengerV2, and every chain it pays across chains
 * that has a CCTP domain; null on a network without CCTP, which deploys version 1.
 */
export function spendingLimitTerms(network: NetworkProfile): SpendingLimitTerms | null {
  if (!network.cctp) return null;
  const home = network.cctp.domain;
  let allowedDomains = 0n;
  for (const chain of network.payeeChains.slice(1)) {
    if (chain.domain !== null && chain.domain !== home) allowedDomains |= 1n << BigInt(chain.domain);
  }
  return { tokenMessenger: network.cctp.tokenMessenger, allowedDomains };
}

const checksummed = (address: string) => getAddress(address.toLowerCase());

/** The creation code of version 2 with `terms`, or of version 1 without them. */
export function deploymentData(input: {
  usdc: string;
  treasury: string;
  agent: string;
  dailyUnits: bigint;
  weeklyUnits: bigint;
  terms?: SpendingLimitTerms | null;
}): Hex {
  const parties = [checksummed(input.usdc), checksummed(input.treasury), checksummed(input.agent)] as const;
  if (!input.terms) {
    return encodeDeployData({ ...SPENDING_LIMIT_ARTIFACTS[1], args: [...parties, input.dailyUnits, input.weeklyUnits] });
  }
  return encodeDeployData({
    ...SPENDING_LIMIT_ARTIFACTS[2],
    args: [...parties, checksummed(input.terms.tokenMessenger), input.terms.allowedDomains, input.dailyUnits, input.weeklyUnits],
  });
}

/** `setLimits(daily, weekly)`, which only the contract's owner, its treasury, may call: its figures, in units. Both versions. */
export function setLimitsData(dailyUnits: bigint, weeklyUnits: bigint): Hex {
  return encodeFunctionData({ abi: SPENDING_LIMIT_ARTIFACTS[1].abi, functionName: "setLimits", args: [dailyUnits, weeklyUnits] });
}
