"use server";

import "server-only";

import { z } from "zod";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { publicOrigin } from "@/lib/public-origin";
import { ReceiptError, shareReceipt, stopSharingReceipt } from "@/lib/receipts/share";

export interface ReceiptActionResult {
  ok: boolean;
  message: string;
  /** The receipt's link, given once, when it is made. */
  url?: string;
}

const idSchema = z.string().uuid();

/** Who may share, in which workspace, and which invoice: the checks both actions make first. */
async function receiptAccess(formData: FormData) {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false as const, result: { ok: false, message: auth.message } };
  if (auth.membership.mode !== "live") {
    return { ok: false as const, result: { ok: false, message: "A receipt is for a payment on chain, which a live workspace makes." } };
  }
  const invoiceId = idSchema.safeParse(formData.get("invoiceId"));
  if (!invoiceId.success) return { ok: false as const, result: { ok: false, message: "That invoice is not in this workspace." } };
  return { ok: true as const, auth, invoiceId: invoiceId.data };
}

/**
 * Shares a paid payable's receipt (docs/superpowers/specs/2026-10-01-payment-receipts-design.md P3, P6):
 * the first time, a signed statement of its facts and a link; after that, a new link that replaces the
 * old one. The link is given once.
 */
export async function shareReceiptAction(_previous: ReceiptActionResult, formData: FormData): Promise<ReceiptActionResult> {
  const access = await receiptAccess(formData);
  if (!access.ok) return access.result;
  const { auth, invoiceId } = access;
  return inOrg(auth, async () => {
    try {
      const shared = await shareReceipt({ actorId: auth.user.id, invoiceId });
      revalidateOrgPages();
      return {
        ok: true,
        message: shared.renewed
          ? "New link made. The earlier link no longer opens the receipt. Copy it now: it is shown only once."
          : "Receipt shared. Copy the link now: it is shown only once.",
        url: `${publicOrigin()}/receipt/${shared.token}`,
      };
    } catch (error) {
      if (error instanceof ReceiptError) return { ok: false, message: error.message };
      console.error("receipt share failed");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}

export async function stopSharingReceiptAction(_previous: ReceiptActionResult, formData: FormData): Promise<ReceiptActionResult> {
  const access = await receiptAccess(formData);
  if (!access.ok) return access.result;
  const { auth, invoiceId } = access;
  return inOrg(auth, async () => {
    try {
      await stopSharingReceipt({ actorId: auth.user.id, invoiceId });
      revalidateOrgPages();
      return { ok: true, message: "The receipt's link no longer opens it." };
    } catch (error) {
      if (error instanceof ReceiptError) return { ok: false, message: error.message };
      console.error("receipt revoke failed");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
