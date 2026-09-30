"use server";

import "server-only";

import { refreshOnChainBalances } from "@/lib/agent/balances";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { CIRCLE_UNREACHABLE } from "@/lib/copy";
import { inOrg } from "@/lib/dal/scope";

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
      // Funds arriving may let the agent pay what it held for want of them.
      if (result.rose) raiseCycleEvent(auth, "funds_arrived");
      return { ok: true, balance: result.balance, syncedAt: result.syncedAt };
    } catch {
      console.error("refreshOnChainBalanceAction failed");
      return { ok: false, balance: null, syncedAt: null, message: CIRCLE_UNREACHABLE };
    }
  });
}
