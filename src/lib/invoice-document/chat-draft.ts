import type { InvoiceInput } from "../invoices/create";
import { invoiceFormRefusal, invoiceInputSchema } from "../intake-validation";
import type { InvoiceDraftRead } from "./draft";

/**
 * An invoice a chat read, as the chat holds it until someone presses Add (Telegram bot design R10, Slack design S15).
 * One rule for every chat: a read becomes a draft only when it names a counterparty of the workspace, an amount and a
 * due date, and the invoice form's own rules accept it; otherwise the chat says why, and the invoice is finished in
 * Vestiarion. Pure.
 */

/** Who read an invoice, as a chat says it after "Read by". */
export const READER_NAMES: Record<InvoiceDraftRead["reader"], string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  heuristic: "the written rules (no model answered)",
};

/** The form's fields as text, the way the invoice form posts them: what a draft keeps until its Add. */
export interface ChatDraftFields {
  counterpartyId: string;
  amount: string;
  currency: string;
  memo: string;
  poReference: string;
  dueDate: string;
  earlyPayDiscountPct: string;
  discountDeadline: string;
}

/** A draft as a chat stores it: the fields, and where they were read from. */
export interface StoredChatDraft {
  draft: ChatDraftFields;
  document: { kind: "pdf" | "email" | "text"; sha256: string; reader: InvoiceDraftRead["reader"] };
}

/** A read as a chat's draft: stored when it can be added from a chat, or the reasons it cannot, in words. */
export function chatDraftOf(read: InvoiceDraftRead): { reasons: string[]; stored: StoredChatDraft | null } {
  const { draft } = read;
  const reasons: string[] = [];
  if (!draft.counterpartyId) {
    reasons.push(
      draft.vendorName ? `no counterparty in this workspace matches “${draft.vendorName}”` : "no counterparty in this workspace matches the invoice's vendor"
    );
  }
  if (!draft.amount) reasons.push("no amount could be read");
  if (!draft.dueDate) reasons.push("no due date could be read");
  if (reasons.length > 0 || !draft.counterpartyId) return { reasons, stored: null };

  const fields: ChatDraftFields = {
    counterpartyId: draft.counterpartyId,
    amount: draft.amount ?? "",
    currency: draft.currency ?? "USDC",
    memo: draft.memo ?? "",
    poReference: draft.poReference ?? "",
    dueDate: draft.dueDate ?? "",
    earlyPayDiscountPct: draft.earlyPayDiscountPct ?? "",
    discountDeadline: draft.discountDeadline ?? "",
  };
  const parsed = invoiceInputSchema.safeParse({ direction: "payable", ...fields, goodsReceived: false });
  if (!parsed.success) return { reasons: [invoiceFormRefusal(parsed.error).message], stored: null };
  return { reasons: [], stored: { draft: fields, document: { kind: read.document.kind, sha256: read.document.sha256, reader: read.reader } } };
}

/** The payable a stored draft becomes, with the goods as the person said; null if the form's rules no longer accept it. */
export function invoiceOfDraft(stored: StoredChatDraft, goodsReceived: boolean): InvoiceInput | null {
  const parsed = invoiceInputSchema.safeParse({ direction: "payable", ...stored.draft, goodsReceived });
  return parsed.success ? parsed.data : null;
}
