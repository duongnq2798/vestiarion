import { encodeFunctionData, erc20Abi, maxUint256, type Hex } from "viem";
import { setLimitsData } from "../spending-limit/deployment";
import { figureUnits } from "../usdc-figure";

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

/** What the contract holds now, as the panel read it: null where it holds no such figure. */
export interface HeldFigures {
  dailyUsdc: number | null;
  weeklyUsdc: number | null;
}

/**
 * One typed figure in units (review C1): read as every other figure is (`parseFigure`), so 0, a hex number or a 7th
 * decimal is refused rather than sent as no figure. Empty keeps a figure the contract does not hold; a figure it holds
 * is never removed from here, since 0 on chain means no figure at all.
 */
function typedUnits(typed: string, name: string, held: number | null): bigint {
  const read = figureUnits(typed, name);
  if (!read.ok) throw new WalletControlError(read.message);
  if (read.units !== null) return read.units;
  if (held !== null) throw new WalletControlError(`Enter a ${name} above 0 USDC. The contract holds one now, and this page does not remove it.`);
  return 0n;
}

/** `setLimits(daily, weekly)` on the contract, which only its owner, the treasury wallet, may call. */
export function figuresCall(input: { contract: Hex; daily: string; weekly: string; holds: HeldFigures }): ControlCall & { dailyUnits: bigint; weeklyUnits: bigint } {
  const daily = typedUnits(input.daily, "daily figure", input.holds.dailyUsdc);
  const weekly = typedUnits(input.weekly, "7-day figure", input.holds.weeklyUsdc);
  if ((daily === 0n && weekly === 0n) || (daily > 0n && weekly > 0n && weekly < daily)) throw new WalletControlError(FIGURES_REFUSED);
  return { to: input.contract, data: setLimitsData(daily, weekly), value: 0n, dailyUnits: daily, weeklyUnits: weekly };
}

/** Stops the agent's payments: the contract may move none of the treasury's USDC. */
export function stopCall(input: { usdc: Hex; contract: Hex }): ControlCall {
  return { to: input.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [input.contract, 0n] }), value: 0n };
}

/** Resumes them: the contract may move the treasury's USDC again, without a cap or up to one, read like a figure. */
export function resumeCall(input: { usdc: Hex; contract: Hex; cap: string }): ControlCall {
  const read = figureUnits(input.cap, "cap");
  if (!read.ok) throw new WalletControlError(CAP_REFUSED);
  const cap = read.units ?? maxUint256;
  return { to: input.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [input.contract, cap] }), value: 0n };
}
