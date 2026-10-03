"use server";

import "server-only";

import { z } from "zod";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { consoleActor } from "@/lib/commands/actor";
import { issuePayeeLink } from "@/lib/commands/payee-links";
import { revokePayeeLink } from "@/lib/platform/payee-links";

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

/** Makes a link through the command every surface shares (`issuePayeeLink`, write API part 2 W4), and shows it once. */
export async function createPayeeLinkAction(_previous: PayeeLinkActionResult, formData: FormData): Promise<PayeeLinkActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const counterpartyId = idSchema.safeParse(formString(formData, "counterpartyId"));
  if (!counterpartyId.success) return { ok: false, message: "Counterparty not found." };
  return inOrg(auth, async () => {
    const outcome = await issuePayeeLink(consoleActor(auth), { counterpartyId: counterpartyId.data });
    if (!outcome.ok) return { ok: false, message: outcome.message };
    revalidateOrgPages();
    return { ok: true, message: outcome.message, url: outcome.url, expiresAt: outcome.expiresAt };
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
