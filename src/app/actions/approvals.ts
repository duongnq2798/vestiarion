"use server";

import "server-only";

import { z } from "zod";
import { approveAndPay, ApprovalError, rejectInvoice, returnInvoice } from "@/lib/agent/approvals";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";

export interface ApprovalActionResult {
  ok: boolean;
  message: string;
}

const invoiceIdSchema = z.string().uuid();

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** An `ApprovalError` carries a message safe to show; anything else stays in the server log. */
function fail(error: unknown): ApprovalActionResult {
  if (error instanceof ApprovalError) return { ok: false, message: error.message };
  console.error("approval action failed", error);
  return { ok: false, message: "That did not work. Try again in a moment." };
}

/**
 * `payInvoice`'s note on a failed transfer, via `approveAndPay`, reads
 * ` [transfer failed: <reason>]` (a payment that never reached the provider
 * reads ` [execution failed: <reason>]`). Pulls the reason out of either
 * shape for the message a person sees; a note that does not match either is
 * shown trimmed, whole, rather than dropped.
 */
function heldMessage(note: string): string {
  const match = /\[(?:transfer|execution) failed:\s*(.+?)\]\s*$/.exec(note);
  const reason = match ? match[1] : note.trim();
  return `The transfer failed: ${reason}. The invoice is held.`;
}

export async function approveInvoiceAction(_previous: ApprovalActionResult, formData: FormData): Promise<ApprovalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = invoiceIdSchema.safeParse(formString(formData, "invoiceId"));
    if (!parsed.success) return { ok: false, message: "That invoice is not waiting for a decision." };
    try {
      const result = await approveAndPay({ actorId: auth.user.id, invoiceId: parsed.data });
      revalidateOrgPages();
      const message =
        result.status === "paid"
          ? "Paid."
          : result.status === "matched"
            ? "Payment submitted; waiting for confirmation."
            : heldMessage(result.note);
      return { ok: true, message };
    } catch (error) {
      return fail(error);
    }
  });
}

export async function rejectInvoiceAction(_previous: ApprovalActionResult, formData: FormData): Promise<ApprovalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = invoiceIdSchema.safeParse(formString(formData, "invoiceId"));
    if (!parsed.success) return { ok: false, message: "That invoice is not waiting for a decision." };
    try {
      await rejectInvoice({ actorId: auth.user.id, invoiceId: parsed.data, reason: formString(formData, "reason") });
      revalidateOrgPages();
      return { ok: true, message: "Rejected." };
    } catch (error) {
      return fail(error);
    }
  });
}

export async function returnInvoiceAction(_previous: ApprovalActionResult, formData: FormData): Promise<ApprovalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = invoiceIdSchema.safeParse(formString(formData, "invoiceId"));
    if (!parsed.success) return { ok: false, message: "That invoice is not waiting for a decision." };
    try {
      await returnInvoice({ actorId: auth.user.id, invoiceId: parsed.data });
      revalidateOrgPages();
      return { ok: true, message: "Returned to the agent. The next cycle decides it again." };
    } catch (error) {
      return fail(error);
    }
  });
}
