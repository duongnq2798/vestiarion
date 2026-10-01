"use server";

import "server-only";

import { z } from "zod";
import { refreshOnChainBalances } from "@/lib/agent/balances";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { fundGateway } from "@/lib/circle/gateway-funding";
import { CIRCLE_UNREACHABLE } from "@/lib/copy";
import { inOrg } from "@/lib/dal/scope";
import { firstZodMessage, usdcAmountSchema } from "@/lib/intake-validation";

export interface RefreshBalanceResult {
  ok: boolean;
  /** The non-reserve accounts' total, as stored after the read; null when nothing could be read. */
  balance: number | null;
  /** When the operating account's balance was last read from the chain, if ever. */
  syncedAt: string | null;
  message?: string;
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
      const result = await refreshOnChainBalances();
      if (result.reason === "unavailable") {
        return { ok: false, balance: result.balance, syncedAt: result.syncedAt, message: result.message ?? CIRCLE_UNREACHABLE };
      }
      return { ok: true, balance: result.balance, syncedAt: result.syncedAt };
    } catch {
      console.error("refreshOnChainBalanceAction failed");
      return { ok: false, balance: null, syncedAt: null, message: CIRCLE_UNREACHABLE };
    }
  });
}

export interface FundGatewayResult {
  ok: boolean;
  message: string;
}

const requestIdSchema = z.string().uuid();

/**
 * Funds the workspace's Gateway balance from its operating wallet (Gateway
 * payouts G1): an owner's or admin's deliberate move of treasury cash, never
 * the agent's. The form carries an id made when it was shown, so a double
 * click or a retry deposits once: every Circle call is keyed by it.
 */
export async function fundGatewayAction(_previous: FundGatewayResult, formData: FormData): Promise<FundGatewayResult> {
  const auth = await authorize(formData.get("orgSlug"), "treasury.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
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
      revalidateOrgPages();
      const held = funded.balanceUsdc === null ? "" : ` The Gateway balance is ${funded.balanceUsdc} USDC.`;
      return { ok: true, message: `Deposited ${Number(amount.data)} USDC into Gateway.${held}` };
    } catch (error) {
      // Every error the funding raises is written for the person who asked: its own checks,
      // Circle's call and status (never Circle's text), or Gateway's refusal.
      console.error("fundGatewayAction failed", error instanceof Error ? error.name : "unknown");
      return { ok: false, message: error instanceof Error ? error.message : "The deposit into Gateway did not complete. Try again." };
    }
  });
}
