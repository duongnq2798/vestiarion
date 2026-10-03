"use server";

import "server-only";

import { z } from "zod";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { createPayLink, PayLinkError, setReminders } from "@/lib/platform/pay-links";
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

/**
 * Turns the agent's reminders to the client on or off for an open receivable (collections R1): an owner's or admin's
 * choice, as the pay link. Turning on starts a cycle, so a reminder already due goes within a minute.
 */
export async function setRemindersAction(_previous: PayLinkActionResult, formData: FormData): Promise<PayLinkActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const invoiceId = z.string().uuid().safeParse(formData.get("invoiceId"));
  if (!invoiceId.success) return { ok: false, message: "That receivable was not found." };
  const on = formData.get("on") === "true";
  return inOrg(auth, async () => {
    try {
      const result = await setReminders({ actorId: auth.user.id, invoiceId: invoiceId.data, on });
      revalidateOrgPages();
      if (!on) return { ok: true, message: `The agent no longer reminds ${result.counterpartyName}.` };
      raiseCycleEvent(auth, "reminders_on");
      return {
        ok: true,
        message: result.replacedLink
          ? `Reminders on. The agent decides when to remind ${result.counterpartyName}, with a new pay link: the one sent before no longer works.`
          : result.madeNewLink
            ? `Reminders on. The agent decides when to remind ${result.counterpartyName}, with the pay link it just made.`
            : `Reminders on. The agent decides when to remind ${result.counterpartyName}.`,
      };
    } catch (error) {
      if (error instanceof PayLinkError) return { ok: false, message: error.message };
      console.error("reminders not changed", error instanceof Error ? error.name : "unknown");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
