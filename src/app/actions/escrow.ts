"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { EscrowSetupError, setUpEscrow } from "@/lib/circle/escrow-setup";
import { inOrg } from "@/lib/dal/scope";

export interface EscrowActionResult {
  ok: boolean;
  message: string;
}

/**
 * Sets up the workspace's milestone escrow (docs/superpowers/specs/2026-10-01-milestone-escrow-design.md E2):
 * an owner's or admin's deliberate act, in a live workspace. Pressed again, it finishes a setup that was
 * interrupted; it never deploys twice.
 */
export async function setUpEscrowAction(_previous: EscrowActionResult, formData: FormData): Promise<EscrowActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "treasury.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  if (auth.membership.mode !== "live") {
    return { ok: false, message: "Escrow is a contract on Arc testnet, for a live workspace. Take this workspace live first." };
  }
  return inOrg(auth, async () => {
    try {
      const escrow = await setUpEscrow({ actorId: auth.user.id });
      revalidateOrgPages();
      return { ok: true, message: `Escrow is set up at ${escrow.address}. Lock a milestone in it from its card.` };
    } catch (error) {
      if (error instanceof EscrowSetupError) {
        revalidateOrgPages();
        return { ok: false, message: error.message };
      }
      console.error("setUpEscrowAction failed", error instanceof Error ? error.name : "unknown");
      return { ok: false, message: "Setting up escrow did not finish. Try again: what was done is kept, and nothing is sent twice." };
    }
  });
}
