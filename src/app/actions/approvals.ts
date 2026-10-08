"use server";

import "server-only";

import { z } from "zod";
import { authorize } from "@/lib/auth/authorize";
import { consoleActor } from "@/lib/commands/actor";
import { addPayableDetails, approvePayable, rejectPayable, returnPayable } from "@/lib/commands/payables";
import { inOrg } from "@/lib/dal/scope";
import { invoiceDetailsInputSchema, invoiceFormRefusal } from "@/lib/intake-validation";
import { consoleAnswer } from "./command-result";

export interface ApprovalActionResult {
  ok: boolean;
  message: string;
  /** The payment's transaction on the explorer, for its confirmation to link. */
  txUrl?: string;
}

const invoiceIdSchema = z.string().uuid();

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * The Approvals buttons. Each authorizes the session first, then runs the command every surface shares
 * (src/lib/commands/payables.ts), which raises what follows the decision; the console refreshes its pages whenever
 * the invoice changed, a failed transfer included.
 */
export async function approveInvoiceAction(_previous: ApprovalActionResult, formData: FormData): Promise<ApprovalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = invoiceIdSchema.safeParse(formString(formData, "invoiceId"));
    if (!parsed.success) return { ok: false, message: "That invoice is not waiting for a decision." };
    // The address the card showed goes with the approval, so a changed one is refused rather than paid unseen.
    const outcome = await approvePayable(consoleActor(auth), { invoiceId: parsed.data, shownAddress: formString(formData, "address") });
    return { ...consoleAnswer(outcome), ...(outcome.ok && outcome.txUrl ? { txUrl: outcome.txUrl } : {}) };
  });
}

export async function rejectInvoiceAction(_previous: ApprovalActionResult, formData: FormData): Promise<ApprovalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = invoiceIdSchema.safeParse(formString(formData, "invoiceId"));
    if (!parsed.success) return { ok: false, message: "That invoice is not waiting for a decision." };
    return consoleAnswer(await rejectPayable(consoleActor(auth), { invoiceId: parsed.data, reason: formString(formData, "reason") }));
  });
}

export async function returnInvoiceAction(_previous: ApprovalActionResult, formData: FormData): Promise<ApprovalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = invoiceIdSchema.safeParse(formString(formData, "invoiceId"));
    if (!parsed.success) return { ok: false, message: "That invoice is not waiting for a decision." };
    return consoleAnswer(await returnPayable(consoleActor(auth), { invoiceId: parsed.data }));
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
    return consoleAnswer(await addPayableDetails(consoleActor(auth), { invoiceId: invoiceId.data, ...details.data }));
  });
}
