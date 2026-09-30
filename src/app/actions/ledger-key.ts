"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { LedgerKeyError, rotateLedgerKey } from "@/lib/platform/ledger-key";

/**
 * Rotating a workspace's ledger signing key from Settings
 * (docs/superpowers/specs/2026-09-30-ledger-key-rotation-design.md §1). Owner
 * only; the library does the work and writes its own ledger entry, in a fresh
 * scope entered after the swap — this action's own `inOrg` scope still holds
 * the key that was just retired, so it appends nothing and signs nothing.
 */

export interface LedgerKeyActionResult {
  ok: boolean;
  message: string;
}

function failure(error: unknown, what: string): LedgerKeyActionResult {
  if (error instanceof LedgerKeyError) return { ok: false, message: error.message };
  console.error(what, error instanceof Error ? error.message : "unknown error");
  return { ok: false, message: "That did not work. Try again in a moment." };
}

export async function rotateLedgerKeyAction(_previous: LedgerKeyActionResult, formData: FormData): Promise<LedgerKeyActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const { from, to } = await rotateLedgerKey({ orgId: auth.membership.orgId, actorId: auth.user.id });
      revalidateOrgPages();
      return { ok: true, message: `Signing key rotated: ${from} retired, ${to} now signs.` };
    } catch (error) {
      return failure(error, "ledger key rotation failed");
    }
  });
}
