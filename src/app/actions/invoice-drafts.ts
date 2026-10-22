"use server";

import "server-only";

import { consoleAnswer } from "@/app/actions/command-result";
import type { IntakeActionResult } from "@/app/actions/intake";
import { authorize } from "@/lib/auth/authorize";
import { consoleActor } from "@/lib/commands/actor";
import { confirmInvoiceDraft, discardInvoiceDraft } from "@/lib/commands/invoice-drafts";
import { inOrg } from "@/lib/dal/scope";
import { CaptureNotSetUpError } from "@/lib/extension/tokens";
import { capturedText } from "@/lib/invoice-drafts/store";
import { invoiceFormRefusal, invoiceInputSchema } from "@/lib/intake-validation";

/**
 * A draft the Chrome extension captured, decided on Bills & receivables (docs/superpowers/specs/2026-10-15-invoice-
 * capture-design.md C5-C7): added as a bill through the invoice form's own rules and the add-invoice command, or
 * discarded. A records write, an owner's or admin's, as adding any bill is.
 */

export interface DraftActionResult {
  ok: boolean;
  message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALREADY_DECIDED = "This draft was already decided.";
const NOT_SET_UP = "Invoice capture is not set up on this deployment yet.";
const TRY_AGAIN = "That did not work. Try again in a moment.";

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** Add as bill: the form as the person finished it, always a payable, through `invoice_draft.confirm`. */
export async function confirmInvoiceDraftAction(_previous: IntakeActionResult, formData: FormData): Promise<IntakeActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const draftId = formString(formData, "invoiceDraftId");
  if (!UUID.test(draftId)) return { ok: false, message: ALREADY_DECIDED };
  const parsed = invoiceInputSchema.safeParse({
    direction: "payable",
    counterpartyId: formString(formData, "counterpartyId"),
    amount: formString(formData, "amount"),
    currency: formString(formData, "currency"),
    memo: formString(formData, "memo"),
    poReference: formString(formData, "poReference"),
    invoiceNumber: formString(formData, "invoiceNumber"),
    goodsReceived: formData.get("goodsReceived") === "on",
    dueDate: formString(formData, "dueDate"),
    earlyPayDiscountPct: formString(formData, "earlyPayDiscountPct"),
    discountDeadline: formString(formData, "discountDeadline"),
  });
  if (!parsed.success) return { ok: false, ...invoiceFormRefusal(parsed.error) };
  const invoice = parsed.data;
  const notDuplicate = formData.get("notDuplicate") === "on";
  return inOrg(auth, async () => {
    try {
      const outcome = await confirmInvoiceDraft(consoleActor(auth), { draftId, invoice, notDuplicate });
      const answer = consoleAnswer(outcome);
      if (answer.ok) return { ...answer, created: 1 };
      // A possible duplicate found with what the person chose: the form then asks them to say it is not one.
      return !outcome.ok && outcome.code === "possible_duplicate" ? { ...answer, duplicate: true as const } : answer;
    } catch (error) {
      if (error instanceof CaptureNotSetUpError) return { ok: false, message: NOT_SET_UP };
      console.error("confirmInvoiceDraftAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/** Discard: the draft leaves the list, and its captured text goes. */
export async function discardInvoiceDraftAction(_previous: DraftActionResult, formData: FormData): Promise<DraftActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const draftId = formString(formData, "invoiceDraftId");
  if (!UUID.test(draftId)) return { ok: false, message: ALREADY_DECIDED };
  return inOrg(auth, async () => {
    try {
      return consoleAnswer(await discardInvoiceDraft(consoleActor(auth), { draftId }));
    } catch (error) {
      if (error instanceof CaptureNotSetUpError) return { ok: false, message: NOT_SET_UP };
      console.error("discardInvoiceDraftAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}

/**
 * The text a sent draft was read from, read when someone opens What was captured (C9): never part of the page itself,
 * which every refresh sends again. Any member reads it, as they read the draft.
 */
export async function readCapturedTextAction(orgSlug: string, draftId: string): Promise<{ ok: boolean; message: string; text?: string | null }> {
  const auth = await authorize(orgSlug, "workspace.read");
  if (!auth.ok) return { ok: false, message: auth.message };
  if (!UUID.test(draftId)) return { ok: false, message: ALREADY_DECIDED };
  return inOrg(auth, async () => {
    try {
      return { ok: true, message: "", text: await capturedText(draftId) };
    } catch (error) {
      if (error instanceof CaptureNotSetUpError) return { ok: false, message: NOT_SET_UP };
      console.error("readCapturedTextAction failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: TRY_AGAIN };
    }
  });
}
