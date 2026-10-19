"use server";

import "server-only";

import { z } from "zod";
import { askPayeesForAddresses, type AddressRequests } from "@/lib/address-requests";
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
  /** Only when the link just made asks for the payee's invoice (payee invoice link P1). */
  asksInvoice?: true;
}

const idSchema = z.string().uuid();

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * Makes a link through the command every surface shares (`issuePayeeLink`, write API part 2 W4), and shows it once. The
 * two boxes under the dialog's text (payee invoice link P1) submit `asksInvoice` and `offersChain` when ticked.
 */
export async function createPayeeLinkAction(_previous: PayeeLinkActionResult, formData: FormData): Promise<PayeeLinkActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const counterpartyId = idSchema.safeParse(formString(formData, "counterpartyId"));
  if (!counterpartyId.success) return { ok: false, message: "Counterparty not found." };
  const asksInvoice = formString(formData, "asksInvoice") === "on";
  const offersChain = formString(formData, "offersChain") === "on";
  const options = asksInvoice || offersChain ? { options: { ...(asksInvoice ? { asksInvoice } : {}), ...(offersChain ? { offersChain } : {}) } } : {};
  return inOrg(auth, async () => {
    const outcome = await issuePayeeLink(consoleActor(auth), { counterpartyId: counterpartyId.data, ...options });
    if (!outcome.ok) return { ok: false, message: outcome.message };
    revalidateOrgPages();
    return { ok: true, message: outcome.message, url: outcome.url, expiresAt: outcome.expiresAt, ...(asksInvoice ? { asksInvoice: true as const } : {}) };
  });
}

export interface AskEveryPayeeResult {
  ok: boolean;
  message: string;
  /** Only once the links were made: who got theirs by email, and the links shown this once to copy. */
  asked?: AddressRequests;
}

/**
 * Ask every payee for an address at once (ask every payee A4): the payees listed on the page, re-read now, each get a
 * link through the command a single link uses, emailed where they have a notice email.
 */
export async function askEveryPayeeAction(_previous: AskEveryPayeeResult, formData: FormData): Promise<AskEveryPayeeResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const ids = formData.getAll("counterpartyId").map(String);
  return inOrg(auth, async () => {
    try {
      const result = await askPayeesForAddresses({ actor: consoleActor(auth), orgName: auth.membership.name, counterpartyIds: ids });
      if (!result.ok) return { ok: false, message: result.message };
      revalidateOrgPages();
      const made = result.asked.emailed.length + result.asked.links.length;
      if (made === 0 && result.asked.notMade.length === 0) return { ok: false, message: "Every payee listed has an address or a link out now. Reload the page." };
      const message = made === 0 ? "No link was made. Ask each payee from its row." : `Asked ${made} ${made === 1 ? "payee" : "payees"} for an address.`;
      return { ok: true, message, asked: result.asked };
    } catch (error) {
      console.error("ask every payee failed", error instanceof Error ? error.message : "unknown error");
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
