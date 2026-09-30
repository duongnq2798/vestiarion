"use server";

import "server-only";

import { refreshOnChainBalances } from "@/lib/agent/balances";
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
 * The console's balance tile: reads the balance from the chain, at most every
 * 30 seconds, and answers with the number and when it was read. Any member may
 * ask (`workspace.read`): it moves nothing, and the stored balance it may
 * update is what every member already sees. The tile updates itself from the
 * answer, so nothing is revalidated; the console renders per request, so a
 * reload shows the new number anyway. No error of Circle's is logged or
 * returned — only this action's name, and a fixed sentence.
 */
export async function refreshBalanceAction(orgSlug: string): Promise<RefreshBalanceResult> {
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
      console.error("refreshBalanceAction failed");
      return { ok: false, balance: null, syncedAt: null, message: CIRCLE_UNREACHABLE };
    }
  });
}
