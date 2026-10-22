import type { VestiarionConfig } from "./config";
import type { Network } from "./network";

/**
 * Arc mainnet behind a switch (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md M1, M4): who may open and
 * take live a mainnet workspace, and why one cannot move money now. Pure, so client components can read its words:
 * a server caller hands it the deployment's settings (`currentConfig()`).
 */

export const MAINNET_NOT_OPEN = "Arc mainnet is not open to this account yet.";
export const MAINNET_OFF = "Arc mainnet is switched off on this deployment.";
export const MAINNET_NOT_LIVE = "This workspace is on Arc mainnet and not live yet. Nothing moves until an owner takes it live.";
export const MAINNET_NOT_CONNECTED = "This workspace on Arc mainnet has no Circle account connected yet.";

/**
 * The figure above which a payment on Arc mainnet needs two people (mainnet limits L1, L2): written when a mainnet
 * workspace is created, and read in place of a missing or empty figure there, so a figure always stands on mainnet.
 */
export const MAINNET_STARTING_TWO_APPROVALS = 100;

/**
 * The agent's spending limit a mainnet workspace starts with (mainnet go-live M9): tight, and a figure always stays.
 * Written when a mainnet workspace is created, and read in place of a missing or empty limit there
 * (`readOutflowBudget`), so the agent never pays without one on Arc mainnet.
 */
export const MAINNET_STARTING_BUDGET = { dailyUsdc: 50, weeklyUsdc: 150 } as const;

/**
 * The payee lock a mainnet workspace starts with (docs/superpowers/specs/2026-10-22-payee-lock-mainnet-default-design.md
 * LD1): on, so a changed payout address is paid only after a second person records how they checked it, and with no
 * wait, so a payee's first address through its link is not held a day. An owner changes either in Settings.
 */
export const MAINNET_STARTING_PAYEE_LOCK = { on: true, coolingHours: 0 } as const;

/**
 * Arc mainnet is on, and open to this address (M1): it is on the allowlist, or the allowlist holds `*`, which opens Arc
 * mainnet to everyone once a pilot is done. `*` is never implied: an empty allowlist opens it to no one. No address is
 * never allowed.
 */
export function mayUseMainnet(email: string | null | undefined, config: Pick<VestiarionConfig, "mainnetEnabled" | "mainnetAllowlist">): boolean {
  if (!config.mainnetEnabled || !email) return false;
  const allowlist = config.mainnetAllowlist ?? [];
  return allowlist.includes("*") || allowlist.includes(email.trim().toLowerCase());
}

/** Whether Arc mainnet is on and open to every account (`*` on the allowlist), as the landing's questions say it. */
export function mainnetOpenToEveryone(config: Pick<VestiarionConfig, "mainnetEnabled" | "mainnetAllowlist">): boolean {
  return Boolean(config.mainnetEnabled) && (config.mainnetAllowlist ?? []).includes("*");
}

/**
 * Why a workspace cannot move money now because of its network, or null (M4): on Arc mainnet, while the deployment has
 * it off, and until the workspace is live. Arc testnet holds nothing here; the platform's stop switch still applies.
 */
export function networkHold(network: Network, mode: "sandbox" | "live", config: Pick<VestiarionConfig, "mainnetEnabled">): string | null {
  if (network !== "arc-mainnet") return null;
  if (!config.mainnetEnabled) return MAINNET_OFF;
  return mode === "live" ? null : MAINNET_NOT_LIVE;
}
