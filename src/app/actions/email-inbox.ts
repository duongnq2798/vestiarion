"use server";

import "server-only";

import { consoleAnswer } from "@/app/actions/command-result";
import type { IntakeActionResult } from "@/app/actions/intake";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { consoleActor } from "@/lib/commands/actor";
import { addFromInbox, dismissFromInbox, finishFromInbox } from "@/lib/commands/inbox";
import { inOrg } from "@/lib/dal/scope";
import { changeInboxAddress, turnInboxOff, turnInboxOn } from "@/lib/email-inbox/inboxes";
import { invoiceFormRefusal, invoiceInputSchema } from "@/lib/intake-validation";

export interface InboxActionResult {
  ok: boolean;
  message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRY_AGAIN = "That did not work. Try again in a moment.";

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** Adds an emailed invoice as a payable (email invoices design E7, E8): a records write, an owner's or admin's. */
export async function addInboxEmailAction(_previous: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const inboxEmailId = formString(formData, "inboxEmailId");
  if (!UUID.test(inboxEmailId)) return { ok: false, message: "This email was already decided." };
  return inOrg(auth, async () =>
    consoleAnswer(await addFromInbox(consoleActor(auth), { inboxEmailId, goodsReceived: formString(formData, "goodsReceived") === "true" }))
  );
}

/**
 * Adds an emailed invoice as the person finished it in the invoice form on Bills & receivables (reader follow-up F5): a
 * records write, read by the form's own rules, and always a payable, whatever the form posted.
 */
export async function finishInboxEmailAction(_previous: IntakeActionResult, formData: FormData): Promise<IntakeActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const inboxEmailId = formString(formData, "inboxEmailId");
  if (!UUID.test(inboxEmailId)) return { ok: false, message: "This email was already decided." };
  const parsed = invoiceInputSchema.safeParse({
    direction: "payable",
    counterpartyId: formString(formData, "counterpartyId"),
    amount: formString(formData, "amount"),
    currency: formString(formData, "currency"),
    memo: formString(formData, "memo"),
    poReference: formString(formData, "poReference"),
    goodsReceived: formData.get("goodsReceived") === "on",
    dueDate: formString(formData, "dueDate"),
    earlyPayDiscountPct: formString(formData, "earlyPayDiscountPct"),
    discountDeadline: formString(formData, "discountDeadline"),
  });
  if (!parsed.success) return { ok: false, ...invoiceFormRefusal(parsed.error) };
  const invoice = parsed.data;
  return inOrg(auth, async () => {
    const answer = consoleAnswer(await finishFromInbox(consoleActor(auth), { inboxEmailId, invoice }));
    return answer.ok ? { ...answer, created: 1 } : answer;
  });
}

/** Dismisses an emailed invoice still to decide. */
export async function dismissInboxEmailAction(_previous: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const inboxEmailId = formString(formData, "inboxEmailId");
  if (!UUID.test(inboxEmailId)) return { ok: false, message: "This email was already decided." };
  return inOrg(auth, async () => consoleAnswer(await dismissFromInbox(consoleActor(auth), { inboxEmailId })));
}

/** The outcome of an address change, in the words Settings shows; the error itself goes to the server log. */
async function addressChanged(change: () => Promise<unknown>, said: string): Promise<InboxActionResult> {
  try {
    await change();
    revalidateOrgPages();
    return { ok: true, message: said };
  } catch (error) {
    console.error("invoice address change failed", error instanceof Error ? error.message : "unknown error");
    return { ok: false, message: TRY_AGAIN };
  }
}

/** Turns on the workspace's address (E2): an owner's or admin's, as connecting Slack is. */
export async function turnOnInboxAction(_previous: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () =>
    addressChanged(() => turnInboxOn(auth.membership.orgId, auth.user.id), "Invoices by email are on. Forward invoices to the address shown.")
  );
}

/** A new address in place of the old one, which stops at once. */
export async function changeInboxAddressAction(_previous: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () =>
    addressChanged(() => changeInboxAddress(auth.membership.orgId, auth.user.id), "The address is new. The old one no longer works.")
  );
}

/** Turns the address off; emails already in stay on Bills & receivables. */
export async function turnOffInboxAction(_previous: InboxActionResult, formData: FormData): Promise<InboxActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () =>
    addressChanged(
      () => turnInboxOff(auth.membership.orgId, auth.user.id),
      "Invoices by email are off. Emails already in stay on Bills & receivables."
    )
  );
}
