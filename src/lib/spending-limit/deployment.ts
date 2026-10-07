import { encodeDeployData, encodeFunctionData, getAddress, type Abi, type Hex } from "viem";
import artifact from "./artifact.json";

/**
 * Vestiarion's spending limit contract's creation code for a treasury, its agent and its figures: what a wallet sends to
 * deploy it, directly or through the deterministic deployment proxy, and what a creation call is simulated with to
 * check a deployment (wallet treasury W6, W8; passkey treasury K6). Browser-safe: viem and the compiled artifact only.
 */
export function deploymentData(input: { usdc: string; treasury: string; agent: string; dailyUnits: bigint; weeklyUnits: bigint }): Hex {
  const checksummed = (address: string) => getAddress(address.toLowerCase());
  return encodeDeployData({
    abi: artifact.abi as Abi,
    bytecode: artifact.bytecode as Hex,
    args: [checksummed(input.usdc), checksummed(input.treasury), checksummed(input.agent), input.dailyUnits, input.weeklyUnits],
  });
}

/** `setLimits(daily, weekly)`, which only the contract's owner, its treasury, may call: its figures, in units. */
export function setLimitsData(dailyUnits: bigint, weeklyUnits: bigint): Hex {
  return encodeFunctionData({ abi: artifact.abi as Abi, functionName: "setLimits", args: [dailyUnits, weeklyUnits] });
}
