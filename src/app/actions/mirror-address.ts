"use server";

import "server-only";

import { z } from "zod";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { giveMirrorAddress, MirrorAddressError } from "@/lib/mirror-address";

/**
 * Gives a payee with no Arc address a mirror address, from its row in Counterparties
 * (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S7): someone who may add records asks, and the library makes
 * the wallet, writes it only where the payee still has no address, and signs it.
 */

export interface MirrorAddressActionResult {
  ok: boolean;
  message: string;
}

const counterpartyIdSchema = z.string().uuid();

export async function giveMirrorAddressAction(_previous: MirrorAddressActionResult, formData: FormData): Promise<MirrorAddressActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const counterpartyId = counterpartyIdSchema.safeParse(formData.get("counterpartyId"));
  if (!counterpartyId.success) return { ok: false, message: new MirrorAddressError("not_found").message };
  return inOrg(auth, async () => {
    try {
      const mirror = await giveMirrorAddress({ actorId: auth.user.id, counterpartyId: counterpartyId.data });
      revalidateOrgPages();
      return { ok: true, message: `Mirror address given: ${mirror.address}. Payments you agree to are made to it.` };
    } catch (error) {
      if (error instanceof MirrorAddressError) return { ok: false, message: error.message };
      console.error("mirror address failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
