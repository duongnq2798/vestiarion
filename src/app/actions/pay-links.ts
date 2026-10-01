"use server";

import "server-only";

import { z } from "zod";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { createPayLink, PayLinkError } from "@/lib/platform/pay-links";
import { publicOrigin } from "@/lib/public-origin";

export interface PayLinkActionResult {
  ok: boolean;
  message: string;
  /** The link, shown once, to copy. */
  url?: string;
}

/** Makes (or replaces) an open receivable's pay link, for its client (receivables on Arc §2). */
export async function createPayLinkAction(_previous: PayLinkActionResult, formData: FormData): Promise<PayLinkActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const invoiceId = z.string().uuid().safeParse(formData.get("invoiceId"));
    if (!invoiceId.success) return { ok: false, message: "That receivable was not found." };
    try {
      const { token } = await createPayLink({ actorId: auth.user.id, invoiceId: invoiceId.data });
      revalidateOrgPages();
      return { ok: true, message: "Pay link ready. Send it to your client.", url: `${publicOrigin()}/pay/${token}` };
    } catch (error) {
      if (error instanceof PayLinkError) return { ok: false, message: error.message };
      console.error("pay link failed", error instanceof Error ? error.message : error);
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
