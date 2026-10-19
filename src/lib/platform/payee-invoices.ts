import crypto from "node:crypto";
import { z } from "zod";
import { platformDb } from "../dal";
import { withOrg } from "../dal/scope";
import { DocumentReadError, MAX_DOCUMENT_BYTES, readDocument, type DocumentReadErrorCode } from "../invoice-document/read";
import { firstCharacters, MAX_CAPTURED_CHARS, storableText } from "../invoice-drafts/model";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { notifyPayeeInvoice } from "../notifications/payee-invoice";
import { readPayeeInvoice, type PayeeInvoiceField } from "../payee-invoice";
import { takePayeeInvoiceToken } from "../rate-limit";
import { payeeLinkHash } from "./payee-links";

/**
 * A payee's invoice, sent through its payee link (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md P4-P7).
 * No session: the link is the payee's only credential. The fields are checked first, so a typo uses nothing; then the
 * link is looked up, so a page with no live link reads no file; then one of the live link's tries (P6); then the file,
 * when one was sent, is read for its text with the reader of From a document, with no model call, and dropped: only its
 * text and SHA-256 are kept. Then 0133's submit_payee_invoice locks the link, checks it still takes an invoice, and adds
 * the draft, sent for review, in one transaction. Signed as `payee_invoice_submitted` and told to the owners and admins,
 * who add or discard it, both best effort: the draft is written already. Nothing here pays, approves or adds a bill.
 */

export type PayeeInvoiceSubmission =
  | { ok: true; orgName: string }
  | { ok: false; reason: "invalid_link" | "already_sent" | "busy" | "failed_check" }
  | { ok: false; reason: "invalid"; field: PayeeInvoiceField }
  | { ok: false; reason: "file"; code: DocumentReadErrorCode };

export interface PayeeInvoiceInput {
  invoiceNumber: string;
  amount: string;
  dueDate: string;
  note: string;
  /** The invoice as a file, or null; one of no size is none. */
  file: Pick<File, "size" | "name" | "type" | "arrayBuffer"> | null;
}

const submitted = z.object({
  draftId: z.string().uuid(),
  linkId: z.string().uuid(),
  orgId: z.string().uuid(),
  counterpartyId: z.string().uuid(),
  orgName: z.string(),
  payeeName: z.string(),
});

const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export async function submitPayeeInvoice(token: string, input: PayeeInvoiceInput, now: number = Date.now()): Promise<PayeeInvoiceSubmission> {
  const hash = payeeLinkHash(token);
  if (!hash) return { ok: false, reason: "invalid_link" };
  const read = readPayeeInvoice(input, new Date(now).toISOString().slice(0, 10));
  if (!read.ok) return { ok: false, reason: "invalid", field: read.field };
  const file = input.file && input.file.size > 0 ? input.file : null;
  // The size is checked before the bytes are read.
  if (file && file.size > MAX_DOCUMENT_BYTES) return { ok: false, reason: "file", code: "too_large" };
  // The link is looked up before any file is read, so a page with no live link asking for an invoice reads nothing; the
  // database checks it again, under its lock, when the draft is added.
  const status = await platformDb().rpc("payee_link_status", { p_token_hash: hash });
  if (status.error) throw new Error(status.error.message);
  const live = status.data as { asksInvoice?: unknown; invoiceSent?: unknown } | null;
  if (!live || live.asksInvoice !== true) return { ok: false, reason: "invalid_link" };
  if (live.invoiceSent === true) return { ok: false, reason: "already_sent" };
  // One of the live link's tries, before the reader runs: only a live link ever gets a bucket, so made-up tokens add none.
  if (!takePayeeInvoiceToken(hash, now)) return { ok: false, reason: "busy" };

  let document: { kind: "pdf" | "email" | "text"; sha256: string; text: string } | null = null;
  if (file) {
    try {
      const found = await readDocument({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, type: file.type });
      document = { kind: found.kind, sha256: found.sha256, text: firstCharacters(storableText(found.text), MAX_CAPTURED_CHARS) };
    } catch (error) {
      if (error instanceof DocumentReadError) return { ok: false, reason: "file", code: error.code };
      throw error;
    }
  }

  const { invoice } = read;
  const answer = await platformDb().rpc("submit_payee_invoice", {
    p_token_hash: hash,
    p_invoice_number: invoice.invoiceNumber,
    p_amount: invoice.amount,
    p_due_date: invoice.dueDate,
    p_note: invoice.note,
    p_document_kind: document?.kind ?? null,
    p_document_sha256: document?.sha256 ?? null,
    p_raw_text: document?.text ?? null,
    p_request_sha256: sha256hex(JSON.stringify([invoice.invoiceNumber, invoice.amount, invoice.dueDate, invoice.note, document?.sha256 ?? null])),
  });
  if (answer.error) {
    const message = answer.error.message ?? "";
    if (/payee_invoice_link_dead|payee_invoice_not_asked/.test(message)) return { ok: false, reason: "invalid_link" };
    if (/payee_invoice_sent/.test(message)) return { ok: false, reason: "already_sent" };
    // The database's own check of the fields refused what this one passed: said as a fixed sentence.
    if (/payee_invoice_invalid/.test(message)) return { ok: false, reason: "failed_check" };
    throw new Error(message);
  }
  const done = submitted.parse(answer.data);

  // Signed in the workspace's ledger, best effort: the draft is written already. By the payee, so by no member.
  try {
    await withOrg(done.orgId, () =>
      appendLedgerEntryBestEffort(done.orgId, {
        actor: "human",
        domain: "compliance",
        action: "payee_invoice_submitted",
        summary: `${done.payeeName} sent invoice ${invoice.invoiceNumber} for ${invoice.amount} USDC through their payee link; it waits for a member to add it`,
        detail: {
          by: null,
          via: "payee_link",
          linkId: done.linkId,
          draftId: done.draftId,
          counterpartyId: done.counterpartyId,
          amount: invoice.amount,
          currency: "USDC",
          invoiceNumber: invoice.invoiceNumber,
          documentSha256: document?.sha256 ?? null,
        },
      })
    );
  } catch {
    console.error("ledger entry not recorded", "payee_invoice_submitted", done.orgId);
  }
  // Best effort: it never throws.
  await notifyPayeeInvoice({
    orgId: done.orgId,
    orgName: done.orgName,
    payeeName: done.payeeName,
    invoiceNumber: invoice.invoiceNumber,
    amount: invoice.amount,
    dueDate: invoice.dueDate,
  });
  return { ok: true, orgName: done.orgName };
}
