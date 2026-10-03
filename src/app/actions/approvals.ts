"use server";

import "server-only";

import { z } from "zod";
import { addInvoiceDetails, approveAndPay, ApprovalError, rejectInvoice, returnInvoice } from "@/lib/agent/approvals";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { invoiceDetailsInputSchema, invoiceFormRefusal } from "@/lib/intake-validation";
import { sendNoticesSoon } from "@/lib/payment-notices-soon";

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
      const result = await approveAndPay({ actorId: auth.user.id, invoiceId: parsed.data, shownAddress: formString(formData, "address") });
      // The invoice changed either way, so the pages refresh; a transfer that ended held is still a failure
      // to the person who pressed Approve and pay.
      revalidateOrgPages();
      if (result.status === "held") return { ok: false, message: heldMessage(result.note) };
      // A confirmed payment's payee hears of it now, not at the next cycle (payment notices R5).
      if (result.status === "paid") sendNoticesSoon(auth);
      return { ok: true, message: result.status === "paid" ? "Paid." : "Payment submitted; waiting for confirmation." };
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
      raiseCycleEvent(auth, "payable_returned");
      return { ok: true, message: "Returned to the agent. It usually decides it again within a minute." };
    } catch (error) {
      return fail(error);
    }
  });
}

/**
 * Adds the purchase order or goods receipt a held payable was missing (complete held invoice). Entering facts is a
 * records write, for owners and admins: an approver decides payments, and does not enter them (R1). The payable keeps
 * its status; the cycle the event starts reopens it on the changed facts and decides it again (R4).
 */
export async function addInvoiceDetailsAction(_previous: ApprovalActionResult, formData: FormData): Promise<ApprovalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const invoiceId = invoiceIdSchema.safeParse(formString(formData, "invoiceId"));
    if (!invoiceId.success) return { ok: false, message: "That invoice is not waiting for a decision." };
    const details = invoiceDetailsInputSchema.safeParse({
      poReference: formString(formData, "poReference"),
      goodsReceived: formData.get("goodsReceived") === "on",
    });
    if (!details.success) return { ok: false, message: invoiceFormRefusal(details.error).message };
    try {
      await addInvoiceDetails({ actorId: auth.user.id, invoiceId: invoiceId.data, ...details.data });
      revalidateOrgPages();
      raiseCycleEvent(auth, "details_added");
      return { ok: true, message: "Details added. The agent usually decides it again within a minute." };
    } catch (error) {
      return fail(error);
    }
  });
}
