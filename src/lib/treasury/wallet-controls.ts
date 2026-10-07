import { encodeFunctionData, erc20Abi, maxUint256, type Hex } from "viem";
import { setLimitsData } from "../spending-limit/deployment";

/**
 * The calls a treasury's own wallet signs to change its contract's figures, or to stop and resume the agent's payments
 * (docs/superpowers/specs/2026-10-07-treasury-wallet-controls-design.md C2). Built in the browser from what the panel
 * shows, never from a server's reply, so what the wallet signs is what the owner typed; refused here where the contract
 * would refuse them, before anything is signed. Browser-safe.
 */

/** The wallet route's own words for figures the contract refuses (`_setLimits`). */
export const FIGURES_REFUSED = "Set a daily figure, a 7-day figure, or both, above 0 USDC. The 7-day figure cannot be below the daily one.";
const CAP_REFUSED = "Give the cap in USDC, above 0, or leave it empty.";

export class WalletControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletControlError";
  }
}

export interface ControlCall {
  to: Hex;
  data: Hex;
  value: bigint;
}

/** A figure typed in USDC, in its 6-decimal units, rounded once as the server rounds them: 0 when empty, null when not a figure. */
function units(typed: string): bigint | null {
  const text = typed.trim();
  if (text === "") return 0n;
  const usdc = Number(text);
  if (!Number.isFinite(usdc) || usdc < 0) return null;
  return BigInt(Math.round(usdc * 1_000_000));
}

/** `setLimits(daily, weekly)` on the contract, which only its owner, the treasury wallet, may call. */
export function figuresCall(input: { contract: Hex; daily: string; weekly: string }): ControlCall & { dailyUnits: bigint; weeklyUnits: bigint } {
  const daily = units(input.daily);
  const weekly = units(input.weekly);
  const refused = daily === null || weekly === null || (daily === 0n && weekly === 0n) || (daily > 0n && weekly > 0n && weekly < daily);
  if (refused) throw new WalletControlError(FIGURES_REFUSED);
  return { to: input.contract, data: setLimitsData(daily, weekly), value: 0n, dailyUnits: daily, weeklyUnits: weekly };
}

/** Stops the agent's payments: the contract may move none of the treasury's USDC. */
export function stopCall(input: { usdc: Hex; contract: Hex }): ControlCall {
  return { to: input.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [input.contract, 0n] }), value: 0n };
}

/** Resumes them: the contract may move the treasury's USDC again, without a cap or up to one. */
export function resumeCall(input: { usdc: Hex; contract: Hex; cap: string }): ControlCall {
  const cap = input.cap.trim() === "" ? maxUint256 : units(input.cap);
  if (cap === null || cap === 0n) throw new WalletControlError(CAP_REFUSED);
  return { to: input.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [input.contract, cap] }), value: 0n };
}
