"use server";

import "server-only";

import { z } from "zod";
import { ApprovalError, approveAndPay } from "@/lib/agent/approvals";
import { cosignsNow } from "@/lib/approval-policy";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { consoleActor } from "@/lib/commands/actor";
import { addPayableDetails, approvePayable, approvePayables, rejectPayable, returnPayable, type SelectionLine, type SharedTransaction } from "@/lib/commands/payables";
import { inOrg } from "@/lib/dal/scope";
import { invoiceDetailsInputSchema, invoiceFormRefusal } from "@/lib/intake-validation";
import { COSIGN_OFF, COSIGNED } from "@/lib/two-approvals";
import type { PaymentReceipt } from "@/lib/payment-receipt";
import { consoleAnswer } from "./command-result";

export interface ApprovalActionResult {
  ok: boolean;
  message: string;
  /** What the payment did, for its confirmation to lay out (payment confirmation). */
  receipt?: PaymentReceipt;
}

const invoiceIdSchema = z.string().uuid();

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** The one-line reason a person gave for going against the agent, when they gave one (capability and reasons R10). */
function reasonOf(formData: FormData): { reason?: string } {
  const reason = formString(formData, "reason").trim();
  return reason ? { reason } : {};
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
    // A reason for paying what the agent held, when the person gave one: optional, and never what the payment waits on.
    const outcome = await approvePayable(consoleActor(auth), { invoiceId: parsed.data, shownAddress: formString(formData, "address"), ...reasonOf(formData) });
    return { ...consoleAnswer(outcome), ...(outcome.ok && outcome.receipt ? { receipt: outcome.receipt } : {}) };
  });
}

/** What approving a selection says, laid out one line per bill (docs/superpowers/specs/2026-10-30-approve-many-design.md AM11). */
export interface ApproveManyActionResult {
  /** True when at least one bill was paid, submitted or approved; false when none was, or the selection was refused whole. */
  ok: boolean;
  message: string;
  /** One line per bill, in the order sent; absent when the selection was refused whole (AM3, AM4). */
  bills?: SelectionLine[];
  /** The one Arc transaction bills shared, with its link, when they did. */
  transaction?: SharedTransaction;
}

/**
 * The selection a confirmation sends: one `items` field holding a JSON array, in the page's order, of each bill's id and
 * the address its card showed, `{ invoiceId, address }`. The size is the approvals library's rule (AM3), refused whole
 * there in its words; here only the shape.
 */
const selectionSchema = z.array(z.object({ invoiceId: z.string().uuid(), address: z.string().max(200).optional() }).strict());

function selectionOf(formData: FormData): Array<{ invoiceId: string; shownAddress?: string }> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(formString(formData, "items"));
  } catch {
    return null;
  }
  const parsed = selectionSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.map((item) => ({ invoiceId: item.invoiceId, ...(item.address !== undefined ? { shownAddress: item.address } : {}) }));
}

/**
 * Approves the bills selected on Approvals with one confirmation (approve many AM1): authorized as Approve and pay is,
 * then each decided as one is, with the address its card showed. The pages are refreshed once for the whole selection,
 * whenever anything changed (AM10).
 */
export async function approveManyAction(_previous: ApproveManyActionResult, formData: FormData): Promise<ApproveManyActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const items = selectionOf(formData);
    if (!items) return { ok: false, message: "Those bills are not waiting for a decision." };
    // A reason for paying what the agent held, asked once for the selection: optional, and never what a payment waits on.
    const outcome = await approvePayables(consoleActor(auth), { items, ...reasonOf(formData) });
    const answer = consoleAnswer(outcome);
    if (!outcome.ok) return answer;
    return {
      ok: outcome.bills.some((line) => line.outcome === "paid" || line.outcome === "submitted" || line.outcome === "approved"),
      message: answer.message,
      bills: outcome.bills,
      ...(outcome.transaction ? { transaction: outcome.transaction } : {}),
    };
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
    return consoleAnswer(await returnPayable(consoleActor(auth), { invoiceId: parsed.data, ...reasonOf(formData) }));
  });
}

/**
 * An accountant's co-sign of a bill above the figure for two approvals (docs/superpowers/specs/2026-10-22-accountant-cosign-design.md
 * CS2, CS3, CS7): for `approval.cosign`, the accountant's alone, and only while an owner has turned co-signing on. It runs
 * every check an approval does with the address the card showed, records the co-sign, and pays nothing: an owner's,
 * admin's or approver's Approve and pay then pays it.
 */
export async function cosignInvoiceAction(_previous: ApprovalActionResult, formData: FormData): Promise<ApprovalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.cosign");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = invoiceIdSchema.safeParse(formString(formData, "invoiceId"));
    if (!parsed.success) return { ok: false, message: "That invoice is not waiting for a decision." };
    if (!(await cosignsNow(auth.membership.role))) return { ok: false, message: COSIGN_OFF };
    try {
      await approveAndPay({ actorId: auth.user.id, invoiceId: parsed.data, shownAddress: formString(formData, "address"), cosign: true });
    } catch (error) {
      if (error instanceof ApprovalError) return { ok: false, message: error.message };
      console.error("co-sign failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
    revalidateOrgPages();
    return { ok: true, message: COSIGNED };
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
