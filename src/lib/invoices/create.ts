import type { z } from "zod";
import { db, unwrap } from "../dal";
import { dueDateIso, type invoiceInputSchema } from "../intake-validation";
import type { DocumentProvenance } from "../invoice-document/provenance";
import { appendLedgerEntry } from "../ledger";
import type { OriginalBill } from "../shadow-bills";

/** An invoice as the form's schema accepts it. */
export type InvoiceInput = z.output<typeof invoiceInputSchema>;

/**
 * The deal line a receivable is released from (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D10, D11): the
 * deal, the line and the version it was released under, the deal's title and the line's name, and who released it: a
 * person, or the agent's cycle on the line's invoice day.
 */
export interface DealRelease {
  dealId: string;
  lineId: string;
  version: number;
  title: string;
  line: string;
  releasedBy: "person" | "schedule";
}

/** Where an imported invoice came from (import design B12): the list's SHA-256, its row number, and the bill's invoice number. */
export interface ImportedRow {
  file: string;
  row: number;
  invoiceNumber: string | null;
}

/**
 * Where a bill brought in from an accounting tool came from (Xero connector X11): the provider, and its own ids for the
 * organisation, the bill and the contact, with the bill's number. Its entry names them under the provider's name.
 */
export interface ExternalSource {
  provider: "xero" | "quickbooks" | "zohobooks";
  ids: { tenantId: string; billId: string; contactId: string | null; invoiceNumber: string | null };
}

/**
 * The draft the Chrome extension captured that a person added as this bill (invoice capture design C6), or the invoice a
 * payee sent through its payee link (payee invoice link P5): then `payeeLinkId` names the link, or is null when it could
 * not be read.
 */
export interface CapturedDraft {
  invoiceDraftId: string;
  invoiceNumber: string | null;
  payeeLinkId?: string | null;
}

/**
 * Adds one invoice: the row, and the `create_invoice` entry that says who added it, and where it came from when it
 * was read from a document (invoice from a document D8), added from the Telegram bot (Telegram bot design R10) or from
 * Slack, with the member's link (Slack design S15), from an invoice that arrived by email, with its inbox row (email
 * invoices design E8), added through the API with a key (write API R4), or imported from a bill list, with the list's
 * hash and the row (import design B12). The one way an invoice is added, whether a person typed it into the
 * form, tapped Add on a draft the bot read, or their key sent it. A key's invoice is its issuer's, and nobody's once
 * the issuer's account is gone, as an invoice whose maker deleted their account is. Runs
 * inside the organization's scope; the counterparty is looked up there, so another organization's id is not found,
 * exactly like one that does not exist, and then nothing is written.
 */
export async function createInvoice(input: {
  /** The row's id, when the caller chose it (a captured draft's, invoice capture I1); generated otherwise. */
  id?: string;
  actorId: string | null;
  invoice: InvoiceInput;
  document: DocumentProvenance | null;
  via?: "telegram" | "slack" | "email" | "api" | "import" | "chrome" | "payee_link";
  /** The key that sent it, when it came through the API. */
  apiKeyId?: string;
  /** The member's Slack link, when it was added from Slack (Slack design S15). */
  linkId?: string;
  /** The inbox row it was read from, when it arrived by email (email invoices design E8). */
  inboxEmailId?: string;
  /** The bill as written in the business's own currency, when it was converted to USDC in shadow mode (shadow mode S6). */
  original?: OriginalBill;
  /** The list it was imported from, by the SHA-256 of its text, its row there, and the bill's invoice number (import design B12). */
  imported?: ImportedRow;
  /** The deal line it is released from: a receivable only, one per line (deal schedule D10). */
  deal?: DealRelease;
  /** The accounting tool's bill it was brought in from (Xero connector X11): `via` is the provider's name. */
  external?: ExternalSource;
  /** The draft the Chrome extension captured, or a payee sent, which a person added from the console (invoice capture design C6). */
  captured?: CapturedDraft;
}): Promise<{ id: string; counterpartyName: string } | null> {
  const { id, actorId, invoice, document, via, apiKeyId, linkId, inboxEmailId, original, imported, deal, external, captured } = input;
  // The vendor's own number, typed in or read from a document (receipts v2 RV1); an import or a captured draft names its own below.
  const invoiceNumber = invoice.invoiceNumber ?? null;
  const lookup = await db()
    .from("counterparties")
    .select("id, name")
    .eq("id", invoice.counterpartyId)
    .maybeSingle<{ id: string; name: string }>();
  if (lookup.error) throw new Error(lookup.error.message);
  const counterparty = lookup.data;
  if (!counterparty) return null;

  const values = {
    ...(id ? { id } : {}),
    direction: invoice.direction,
    counterparty_id: counterparty.id,
    amount: invoice.amount,
    currency: invoice.currency,
    memo: invoice.memo,
    po_reference: invoice.poReference,
    goods_received: invoice.goodsReceived,
    due_date: dueDateIso(invoice.dueDate),
    early_pay_discount_pct: invoice.earlyPayDiscountPct,
    discount_due_date: invoice.discountDeadline ? dueDateIso(invoice.discountDeadline) : null,
    created_by: actorId,
    // The bill's own figure beside the USDC it is paid in, all five or none (`invoices_original_complete`).
    ...(original
      ? { original_currency: original.currency, original_amount: original.amount, fx_rate: original.perUsd, fx_source: original.source, fx_at: original.at }
      : {}),
    // Only a released deal line names one: before migration 0104 the columns are not there to name.
    ...(deal ? { deal_id: deal.dealId, deal_line_id: deal.lineId } : {}),
    // The address its document asked to be paid to, which holds a payment to any other (invoice pay-to hold IP1).
    ...(document?.payTo ? { document_pay_to: document.payTo } : {}),
  };
  let inserted = await db().from("invoices").insert(values).select("id").single<{ id: string }>();
  // Before migration 0136 the column is not there: the invoice is added without it, as before, and nothing is held for it.
  if (inserted.error && "document_pay_to" in values && ["PGRST204", "42703"].includes(inserted.error.code ?? "")) {
    console.warn("invoices.document_pay_to is not there yet (migration 0136); the invoice is added without it");
    const { document_pay_to: _left, ...without } = values;
    void _left;
    inserted = await db().from("invoices").insert(without).select("id").single<{ id: string }>();
  }
  const row = unwrap(inserted);

  await appendLedgerEntry({
    // The agent's cycle releases a deal's line on its day when the deal says so; a person adds every other invoice.
    actor: deal?.releasedBy === "schedule" ? "agent" : "human",
    domain: invoice.direction === "payable" ? "ap" : "ar",
    action: "create_invoice",
    summary: `Added ${invoice.direction} invoice for ${counterparty.name}: ${invoice.amount} ${invoice.currency}${original ? ` (${original.amount} ${original.currency})` : ""}${deal ? `, ${deal.line} of the deal ${deal.title}` : ""}`,
    detail: {
      by: actorId,
      invoiceId: row.id,
      counterpartyId: counterparty.id,
      counterpartyName: counterparty.name,
      amount: invoice.amount,
      currency: invoice.currency,
      dueDate: invoice.dueDate,
      poReference: invoice.poReference,
      goodsReceived: invoice.goodsReceived,
      ...(invoiceNumber ? { invoiceNumber } : {}),
      ...(document ? { document } : {}),
      ...(via ? { via } : {}),
      ...(apiKeyId ? { apiKeyId } : {}),
      ...(linkId ? { linkId } : {}),
      ...(inboxEmailId ? { inboxEmailId } : {}),
      ...(original ? { bill: original } : {}),
      ...(imported ? { importFile: imported.file, importRow: imported.row, ...(imported.invoiceNumber ? { invoiceNumber: imported.invoiceNumber } : {}) } : {}),
      ...(deal ? { via: "deal", deal } : {}),
      ...(external ? { via: external.provider, [external.provider]: external.ids } : {}),
      ...(captured
        ? {
            invoiceDraftId: captured.invoiceDraftId,
            ...(captured.invoiceNumber ? { invoiceNumber: captured.invoiceNumber } : {}),
            ...(captured.payeeLinkId !== undefined ? { payeeLinkId: captured.payeeLinkId } : {}),
          }
        : {}),
    },
  });
  return { id: row.id, counterpartyName: counterparty.name };
}
