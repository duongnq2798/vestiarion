import { can, type OrgRole } from "../auth/roles";
import { memberActor } from "../commands/actor";
import { addInvoice } from "../commands/invoices";
import { gate } from "../commands/policy";
import { platformDb, unwrap } from "../dal";
import { chatDraftOf, invoiceOfDraft, type StoredChatDraft } from "../invoice-document/chat-draft";
import { readInvoiceDraft, type InvoiceDraftRead } from "../invoice-document/draft";
import { DocumentReadError, type DocumentInput } from "../invoice-document/read";
import { takeDocumentReadToken } from "../rate-limit";
import type { TelegramClient } from "./client";
import { memberRole, type TelegramLink } from "./links";
import { amountText, draftMessage, escapeHtml, missingMessage, orgUrl } from "./messages";

/**
 * An invoice sent to the bot (Telegram bot design R10): read the way **From a document** reads one, held as a draft
 * for an hour, and added as a payable only when the member taps Add in their own chat. Only an owner or admin, whose
 * role is read again at the tap (R7). Each function runs inside the link's workspace's scope.
 */

/** How long a draft waits for its tap. */
export const DRAFT_TTL_MS = 3_600_000;

export interface IntakeDeps {
  client: TelegramClient;
  origin: string;
  workspace: { slug: string; name: string; mode: "sandbox" | "live" };
  now?: () => Date;
}

/** Why a member cannot add invoices from the chat: no longer a member, or a role without records.write (R7). */
export function roleRefusal(role: OrgRole | null, workspaceName: string): string {
  return role === null
    ? `You are no longer a member of ${escapeHtml(workspaceName)}.`
    : `Only an owner or admin can add invoices. Your role in ${escapeHtml(workspaceName)} is ${role}.`;
}

/** Reads what the member sent into a draft, and offers to add it; or says why it cannot be added from here. */
export async function readDraftForChat(link: TelegramLink, input: DocumentInput, deps: IntakeDeps): Promise<void> {
  const { client, workspace } = deps;
  const role = await memberRole(link.orgId, link.userId);
  if (!can(role, "records.write")) {
    await client.sendMessage(link.chatId, roleRefusal(role, workspace.name));
    return;
  }
  if (!takeDocumentReadToken(link.orgId)) {
    await client.sendMessage(link.chatId, "That is five invoices read this minute. Try again in a few seconds.");
    return;
  }

  let read: InvoiceDraftRead;
  const now = deps.now?.() ?? new Date();
  try {
    read = await readInvoiceDraft(input, now.toISOString().slice(0, 10));
  } catch (error) {
    if (error instanceof DocumentReadError) {
      await client.sendMessage(link.chatId, escapeHtml(error.message));
      return;
    }
    console.error("telegram: invoice read failed", link.orgId, error instanceof Error ? error.message : "unknown error");
    await client.sendMessage(link.chatId, "The invoice could not be read. Try again in a moment.");
    return;
  }

  const { reasons, stored } = chatDraftOf(read);
  if (!stored) {
    await client.sendMessage(link.chatId, missingMessage(read, reasons, orgUrl(deps.origin, workspace.slug, "/invoices")));
    return;
  }

  const draft = unwrap(
    await platformDb()
      .from("telegram_drafts")
      .insert({ link_id: link.id, ...stored, expires_at: new Date(now.getTime() + DRAFT_TTL_MS).toISOString() })
      .select("id")
      .single<{ id: string }>()
  );
  await client.sendMessage(link.chatId, draftMessage(read), {
    keyboard: [
      [{ text: "Add, goods received", callback_data: `add:${draft.id}:1` }],
      [{ text: "Add, not received yet", callback_data: `add:${draft.id}:0` }],
      [{ text: "Cancel", callback_data: `cancel:${draft.id}` }],
    ],
  });
}

export interface DraftTap {
  chatId: number;
  fromId: number;
  messageId: number;
  draftId: string;
  goodsReceived: boolean;
}

/** A tap counts only in the link's own private chat, by the member themself (Review focus 4). */
const ownTap = (link: TelegramLink, tap: DraftTap) => tap.chatId === link.chatId && tap.fromId === link.chatId;

/** Uses a draft up: once, before its hour is over, and only through the link it was read for. */
async function claimDraft(link: TelegramLink, draftId: string, now: Date): Promise<StoredChatDraft | null> {
  const rows = unwrap(
    await platformDb()
      .from("telegram_drafts")
      .update({ used_at: now.toISOString() })
      .eq("id", draftId)
      .eq("link_id", link.id)
      .is("used_at", null)
      .gt("expires_at", now.toISOString())
      .select("draft, document")
  ) as StoredChatDraft[];
  return rows[0] ?? null;
}

const USED = "This draft was already used or has expired. Send the invoice again to read it anew.";

/**
 * Adds the draft as a payable, as the member (R10), through the command every surface shares (integrations design
 * §9), which starts the agent's cycle.
 */
export async function addDraft(link: TelegramLink, tap: DraftTap, deps: IntakeDeps): Promise<"added" | "used" | "refused" | "ignored" | "failed"> {
  if (!ownTap(link, tap)) return "ignored";
  const { client, workspace } = deps;
  const actor = await memberActor(link.orgId, link.userId, { kind: "telegram", linkId: link.id });
  // Asked before the draft is claimed, so a refused tap leaves it for someone who may add it.
  if (!actor || gate(actor, "invoice.add")) {
    await client.editMessageText(tap.chatId, tap.messageId, roleRefusal(actor?.role ?? null, workspace.name));
    return "refused";
  }
  const stored = await claimDraft(link, tap.draftId, deps.now?.() ?? new Date());
  if (!stored) {
    await client.editMessageText(tap.chatId, tap.messageId, USED);
    return "used";
  }

  const invoice = invoiceOfDraft(stored, tap.goodsReceived);
  const added = invoice ? await addInvoice(actor, { invoice, document: { ...stored.document, changed: [] } }) : null;
  if (!invoice || !added?.ok) {
    const reason = added && !added.ok && added.code !== "counterparty_not_found" ? escapeHtml(added.message) : null;
    await client.editMessageText(
      tap.chatId,
      tap.messageId,
      reason ?? "The invoice could not be added: its counterparty is no longer in this workspace. Add it in Vestiarion."
    );
    return "failed";
  }

  await client.editMessageText(
    tap.chatId,
    tap.messageId,
    `Added a payable for ${escapeHtml(added.counterpartyName)}: ${escapeHtml(amountText(invoice.amount, invoice.currency))}, due ${escapeHtml(invoice.dueDate)}, ` +
      `${tap.goodsReceived ? "goods received" : "goods not received yet"}. The agent usually decides within a minute, and its decision will be sent here.`
  );
  return "added";
}

/** Drops the draft unused. */
export async function cancelDraft(link: TelegramLink, tap: Omit<DraftTap, "goodsReceived">, deps: IntakeDeps): Promise<void> {
  if (!ownTap(link, { ...tap, goodsReceived: false })) return;
  const stored = await claimDraft(link, tap.draftId, deps.now?.() ?? new Date());
  await deps.client.editMessageText(tap.chatId, tap.messageId, stored ? "Not added." : USED);
}
