import { runCycleSoon } from "../agent/cycle-soon";
import { can, type OrgRole } from "../auth/roles";
import { platformDb, unwrap } from "../dal";
import { invoiceFormRefusal, invoiceInputSchema } from "../intake-validation";
import { readInvoiceDraft, type InvoiceDraftRead } from "../invoice-document/draft";
import { DocumentReadError, type DocumentInput } from "../invoice-document/read";
import { createInvoice } from "../invoices/create";
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

/** The form's fields as text, the way the invoice form posts them: what a draft keeps until its tap. */
interface DraftFields {
  counterpartyId: string;
  amount: string;
  currency: string;
  memo: string;
  poReference: string;
  dueDate: string;
  earlyPayDiscountPct: string;
  discountDeadline: string;
}

interface StoredDraft {
  draft: DraftFields;
  document: { kind: "pdf" | "email" | "text"; sha256: string; reader: InvoiceDraftRead["reader"] };
}

function roleRefusal(role: OrgRole | null, workspaceName: string): string {
  return role === null
    ? `You are no longer a member of ${escapeHtml(workspaceName)}.`
    : `Only an owner or admin can add invoices. Your role in ${escapeHtml(workspaceName)} is ${role}.`;
}

/** Why a read cannot become a payable from the chat, in words; empty when it can. */
function missing(read: InvoiceDraftRead, fields: DraftFields | null): string[] {
  const reasons: string[] = [];
  if (!read.draft.counterpartyId) {
    reasons.push(
      read.draft.vendorName
        ? `no counterparty in this workspace matches “${read.draft.vendorName}”`
        : "no counterparty in this workspace matches the invoice's vendor"
    );
  }
  if (!read.draft.amount) reasons.push("no amount could be read");
  if (!read.draft.dueDate) reasons.push("no due date could be read");
  if (reasons.length === 0 && fields) {
    const parsed = invoiceInputSchema.safeParse({ direction: "payable", ...fields, goodsReceived: false });
    if (!parsed.success) reasons.push(invoiceFormRefusal(parsed.error).message);
  }
  return reasons;
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

  const fields: DraftFields | null = read.draft.counterpartyId
    ? {
        counterpartyId: read.draft.counterpartyId,
        amount: read.draft.amount ?? "",
        currency: read.draft.currency ?? "USDC",
        memo: read.draft.memo ?? "",
        poReference: read.draft.poReference ?? "",
        dueDate: read.draft.dueDate ?? "",
        earlyPayDiscountPct: read.draft.earlyPayDiscountPct ?? "",
        discountDeadline: read.draft.discountDeadline ?? "",
      }
    : null;
  const reasons = missing(read, fields);
  if (reasons.length > 0 || !fields) {
    await client.sendMessage(link.chatId, missingMessage(read, reasons, orgUrl(deps.origin, workspace.slug, "/invoices")));
    return;
  }

  const stored: StoredDraft = { draft: fields, document: { kind: read.document.kind, sha256: read.document.sha256, reader: read.reader } };
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
async function claimDraft(link: TelegramLink, draftId: string, now: Date): Promise<StoredDraft | null> {
  const rows = unwrap(
    await platformDb()
      .from("telegram_drafts")
      .update({ used_at: now.toISOString() })
      .eq("id", draftId)
      .eq("link_id", link.id)
      .is("used_at", null)
      .gt("expires_at", now.toISOString())
      .select("draft, document")
  ) as StoredDraft[];
  return rows[0] ?? null;
}

const USED = "This draft was already used or has expired. Send the invoice again to read it anew.";

/** Adds the draft as a payable, as the member (R10), and starts the agent's cycle. */
export async function addDraft(link: TelegramLink, tap: DraftTap, deps: IntakeDeps): Promise<"added" | "used" | "refused" | "ignored" | "failed"> {
  if (!ownTap(link, tap)) return "ignored";
  const { client, workspace } = deps;
  const role = await memberRole(link.orgId, link.userId);
  if (!can(role, "records.write")) {
    await client.editMessageText(tap.chatId, tap.messageId, roleRefusal(role, workspace.name));
    return "refused";
  }
  const stored = await claimDraft(link, tap.draftId, deps.now?.() ?? new Date());
  if (!stored) {
    await client.editMessageText(tap.chatId, tap.messageId, USED);
    return "used";
  }

  const parsed = invoiceInputSchema.safeParse({ direction: "payable", ...stored.draft, goodsReceived: tap.goodsReceived });
  const created = parsed.success
    ? await createInvoice({ actorId: link.userId, invoice: parsed.data, document: { ...stored.document, changed: [] }, via: "telegram" })
    : null;
  if (!parsed.success || !created) {
    await client.editMessageText(tap.chatId, tap.messageId, "The invoice could not be added: its counterparty is no longer in this workspace. Add it in Vestiarion.");
    return "failed";
  }

  runCycleSoon({ orgId: link.orgId, userId: link.userId, sandbox: workspace.mode === "sandbox", kind: "invoice_added" });
  const invoice = parsed.data;
  await client.editMessageText(
    tap.chatId,
    tap.messageId,
    `Added a payable for ${escapeHtml(created.counterpartyName)}: ${escapeHtml(amountText(invoice.amount, invoice.currency))}, due ${escapeHtml(invoice.dueDate)}, ` +
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
