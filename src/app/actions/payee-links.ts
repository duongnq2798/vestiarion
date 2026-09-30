"use server";

import "server-only";

import { z } from "zod";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { db, unwrap } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { createPayeeLink, PayeeLinkError, revokePayeeLink } from "@/lib/platform/payee-links";
import { publicOrigin } from "@/lib/public-origin";

/**
 * An owner or admin's side of payee links (spec 2026-09-30-payee-links-design.md
 * §2): make a one-time link for a counterparty, shown once, or revoke an
 * unused one. Both need `records.write`, the permission that edits an address.
 */

export interface PayeeLinkActionResult {
  ok: boolean;
  message: string;
  /** Only when a link was just made: its address, never stored or shown again. */
  url?: string;
  expiresAt?: string;
}

const idSchema = z.string().uuid();

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function createPayeeLinkAction(_previous: PayeeLinkActionResult, formData: FormData): Promise<PayeeLinkActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const counterpartyId = idSchema.safeParse(formString(formData, "counterpartyId"));
  if (!counterpartyId.success) return { ok: false, message: "Counterparty not found." };
  return inOrg(auth, async () => {
    try {
      // A payee link asks someone the agent pays for their address; a client is
      // never paid, and the public page would tell them otherwise.
      const found = unwrap(
        await db().from("counterparties").select("id, role").eq("id", counterpartyId.data).limit(1)
      ) as Array<{ id: string; role: string }>;
      if (found.length === 0) return { ok: false, message: "Counterparty not found." };
      if (found[0].role === "client") return { ok: false, message: "A payee link is for a vendor or a contractor the agent pays." };

      const { link, token } = await createPayeeLink({ orgId: auth.membership.orgId, actorId: auth.user.id, counterpartyId: counterpartyId.data });
      revalidateOrgPages();
      return {
        ok: true,
        message: "Link created. Copy it now: it is shown only once.",
        url: `${publicOrigin()}/payee/${token}`,
        expiresAt: link.expiresAt,
      };
    } catch (error) {
      if (error instanceof PayeeLinkError) return { ok: false, message: error.message };
      console.error("payee link creation failed");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}

export async function revokePayeeLinkAction(_previous: PayeeLinkActionResult, formData: FormData): Promise<PayeeLinkActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const linkId = idSchema.safeParse(formString(formData, "linkId"));
  if (!linkId.success) return { ok: false, message: "That link was already used or revoked." };
  return inOrg(auth, async () => {
    try {
      const revoked = await revokePayeeLink({ orgId: auth.membership.orgId, actorId: auth.user.id, linkId: linkId.data });
      revalidateOrgPages();
      return revoked ? { ok: true, message: "Link revoked. It no longer works." } : { ok: false, message: "That link was already used or revoked." };
    } catch {
      console.error("payee link revocation failed");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
