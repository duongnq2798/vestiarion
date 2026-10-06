"use server";

import "server-only";

import { z } from "zod";
import { refreshOnChainBalances, syncWalletBalances } from "@/lib/agent/balances";
import { authorize } from "@/lib/auth/authorize";
import { FeatureOffError, networkOf, networkProfile } from "@/lib/network";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { fundGateway, fundServiceBudget, GatewayStepFailed } from "@/lib/circle/gateway-funding";
import { CIRCLE_UNREACHABLE } from "@/lib/copy";
import { operatingEurcBalance } from "@/lib/fx/eurc-balance";
import { inOrg } from "@/lib/dal/scope";
import { firstZodMessage, usdcAmountSchema } from "@/lib/intake-validation";
import { enableUsycReserve, UsycReserveError } from "@/lib/platform/usyc-reserve";
import { bringCashBackByPerson, CashBackError } from "@/lib/agent/liquidity";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { agentPaused } from "@/lib/agent/pause";
import { getChainProvider } from "@/lib/circle";
import { PaymentsDisabledError } from "@/lib/payments-switch";

export interface RefreshBalanceResult {
  ok: boolean;
  /** The non-reserve accounts' total, as stored after the read; null when nothing could be read. */
  balance: number | null;
  /** When the operating account's balance was last read from the chain, if ever. */
  syncedAt: string | null;
  message?: string;
  /** The operating wallet's EURC, read from the chain just now; absent when it could not be read, or in a sandbox. */
  eurc?: number;
}

/**
 * The console's balance tile: reads the balance from the chain — at most once
 * per 30 seconds per workspace, and never while a cycle is running — and
 * answers with the number and when it was read. Any member may ask
 * (`workspace.read`): it moves nothing, and the stored balance it may update
 * is what every member already sees.
 *
 * It revalidates nothing: the tile takes the answer itself. When the console
 * is rendered again for another reason (a cycle, an approval, a reload), the
 * page reads the stored figures afresh and the tile remounts on them — it is
 * keyed on them, see `BalanceTile` — so a new figure is never hidden behind
 * the tile's own state. No error of Circle's is logged or returned: only this
 * action's name, and a fixed sentence.
 */
export async function refreshOnChainBalanceAction(orgSlug: string): Promise<RefreshBalanceResult> {
  const auth = await authorize(orgSlug, "workspace.read");
  if (!auth.ok) return { ok: false, balance: null, syncedAt: null, message: auth.message };
  return inOrg(auth, async () => {
    try {
      // The EURC is read from Arc testnet's public RPC, not from Circle: it is not held to the USDC read's cooldown.
      const [result, eurc] = await Promise.all([refreshOnChainBalances(), operatingEurcBalance().catch(() => null)]);
      const withEurc = eurc === null ? {} : { eurc };
      if (result.reason === "unavailable") {
        return { ok: false, balance: result.balance, syncedAt: result.syncedAt, message: result.message ?? CIRCLE_UNREACHABLE, ...withEurc };
      }
      return { ok: true, balance: result.balance, syncedAt: result.syncedAt, ...withEurc };
    } catch {
      console.error("refreshOnChainBalanceAction failed");
      return { ok: false, balance: null, syncedAt: null, message: CIRCLE_UNREACHABLE };
    }
  });
}

export interface FundGatewayResult {
  ok: boolean;
  message: string;
  /** Circle failed a step: the form makes a new request id, since the old one would only be answered with that failure (review I5). */
  renew?: true;
}

const requestIdSchema = z.string().uuid();

/** Gateway on a network that has none is refused by name, before the mode: going live would not bring it (mainnet polish E5). */
function gatewayOffHere(network: string | null | undefined): string | null {
  const profile = networkProfile(networkOf(network));
  return profile.gateway ? null : new FeatureOffError("Paying through Gateway", profile).message;
}

/**
 * Funds the workspace's Gateway balance from its operating wallet (Gateway
 * payouts G1): an owner's or admin's deliberate move of treasury cash, never
 * the agent's. The form carries an id made when it was shown, so a double
 * click or a retry deposits once: every Circle call is keyed by it.
 */
export async function fundGatewayAction(_previous: FundGatewayResult, formData: FormData): Promise<FundGatewayResult> {
  const auth = await authorize(formData.get("orgSlug"), "treasury.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  const gatewayOff = gatewayOffHere(auth.membership.network);
  if (gatewayOff) return { ok: false, message: gatewayOff };
  if (auth.membership.mode !== "live") {
    return { ok: false, message: "Gateway is for a live workspace on Arc testnet. Take this workspace live first." };
  }
  const amount = usdcAmountSchema.safeParse(String(formData.get("amount") ?? ""));
  if (!amount.success) return { ok: false, message: firstZodMessage(amount.error).replace(/^input: /, "") };
  const requestId = requestIdSchema.safeParse(formData.get("requestId"));
  if (!requestId.success) return { ok: false, message: "Reload the page and try again." };

  return inOrg(auth, async () => {
    try {
      const funded = await fundGateway({ actorId: auth.user.id, amount: Number(amount.data), requestId: requestId.data });
      // The deposit left the operating wallet: its stored balance follows before the page is drawn
      // again, so the balance tile and the accounts show it. Best effort: the deposit was made.
      try {
        await syncWalletBalances();
      } catch {
        console.error("fundGatewayAction: the balance read after the deposit did not complete");
      }
      revalidateOrgPages();
      const held =
        funded.balanceUsdc === null
          ? " Gateway counts it once Arc testnet finalizes the deposit, usually within a minute."
          : ` The Gateway balance is ${funded.balanceUsdc} USDC.`;
      return { ok: true, message: `Deposited ${Number(amount.data)} USDC into Gateway.${held}` };
    } catch (error) {
      // Every error the funding raises is written for the person who asked: its own checks,
      // Circle's call and status (never Circle's text), or Gateway's refusal.
      console.error("fundGatewayAction failed", error instanceof Error ? error.name : "unknown");
      if (error instanceof GatewayStepFailed) return { ok: false, message: error.message, renew: true };
      return { ok: false, message: error instanceof Error ? error.message : "The deposit into Gateway did not complete. Try again." };
    }
  });
}

/**
 * Adds to the agent's service budget (x402 payee history R4): an owner's or admin's move of USDC from the
 * operating wallet into Gateway for the signer that pays for lookups, never the agent's. Keyed by the form's
 * request id, like the Gateway funding, so a double click deposits once.
 */
export async function fundServiceBudgetAction(_previous: FundGatewayResult, formData: FormData): Promise<FundGatewayResult> {
  const auth = await authorize(formData.get("orgSlug"), "treasury.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  const gatewayOff = gatewayOffHere(auth.membership.network);
  if (gatewayOff) return { ok: false, message: gatewayOff };
  if (auth.membership.mode !== "live") {
    return { ok: false, message: "The service budget is for a live workspace on Arc testnet. Take this workspace live first." };
  }
  const amount = usdcAmountSchema.safeParse(String(formData.get("amount") ?? ""));
  if (!amount.success) return { ok: false, message: firstZodMessage(amount.error).replace(/^input: /, "") };
  const requestId = requestIdSchema.safeParse(formData.get("requestId"));
  if (!requestId.success) return { ok: false, message: "Reload the page and try again." };

  return inOrg(auth, async () => {
    try {
      const funded = await fundServiceBudget({ actorId: auth.user.id, amount: Number(amount.data), requestId: requestId.data });
      try {
        await syncWalletBalances();
      } catch {
        console.error("fundServiceBudgetAction: the balance read after the deposit did not complete");
      }
      revalidateOrgPages();
      const held =
        funded.balanceUsdc === null
          ? " Gateway counts it once Arc testnet finalizes the deposit, usually within a minute."
          : ` The service budget is ${funded.balanceUsdc} USDC.`;
      return { ok: true, message: `Added ${Number(amount.data)} USDC to the agent's service budget.${held}` };
    } catch (error) {
      console.error("fundServiceBudgetAction failed", error instanceof Error ? error.name : "unknown");
      if (error instanceof GatewayStepFailed) return { ok: false, message: error.message, renew: true };
      return { ok: false, message: error instanceof Error ? error.message : "The deposit into the service budget did not complete. Try again." };
    }
  });
}

export interface UsycReserveActionResult {
  ok: boolean;
  message: string;
}

/**
 * Turns the workspace's real USYC reserve on (USYC live design R1): an owner's or admin's deliberate
 * choice (`treasury.manage`), after Circle allowlisted its wallets. Every refusal is written for the
 * person who asked; the on-chain check names any wallet Circle has still to allowlist.
 */
export async function enableUsycReserveAction(_previous: UsycReserveActionResult, formData: FormData): Promise<UsycReserveActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "treasury.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      await enableUsycReserve({ orgId: auth.membership.orgId, actorId: auth.user.id });
      revalidateOrgPages();
      return { ok: true, message: "The USYC reserve is on. The agent sweeps idle cash into real USYC on Arc testnet from its next cycle." };
    } catch (error) {
      if (error instanceof UsycReserveError) return { ok: false, message: error.message };
      console.error("enableUsycReserveAction failed", error instanceof Error ? error.name : "unknown");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}

/**
 * Brings cash back from the reserve to the operating wallet now (reserve cash back R2): an owner's or admin's choice
 * (`treasury.manage`), the amount they ask or, left empty, everything. Redemptions are open at any hour. The cycle it
 * starts decides again the payments held for want of cash (R4).
 */
export async function bringCashBackAction(_previous: UsycReserveActionResult, formData: FormData): Promise<UsycReserveActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "treasury.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  const raw = typeof formData.get("amount") === "string" ? (formData.get("amount") as string).trim() : "";
  let amount: number | null = null;
  if (raw !== "") {
    const parsed = usdcAmountSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, message: firstZodMessage(parsed.error).replace(/^input: /, "") };
    amount = Number(parsed.data);
  }
  return inOrg(auth, async () => {
    try {
      const result = await bringCashBackByPerson({ actorId: auth.user.id, amount, provider: getChainProvider() });
      revalidateOrgPages();
      // A paused agent runs no cycle: what waited for cash is paid once it is resumed.
      const paused = await agentPaused().catch(() => false);
      raiseCycleEvent(auth, "cash_returned");
      const brought = `Brought ${result.amount} USDC back to the operating wallet.`;
      return {
        ok: true,
        message: paused
          ? `${brought} The agent is paused; it pays what was waiting for cash once it is resumed.`
          : `${brought} The agent pays what was waiting for cash within a minute.`,
      };
    } catch (error) {
      if (error instanceof CashBackError || error instanceof PaymentsDisabledError) return { ok: false, message: error.message };
      console.error("bringCashBackAction failed", error instanceof Error ? error.name : "unknown");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
