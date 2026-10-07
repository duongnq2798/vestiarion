import type { z } from "zod";
import { db, unwrap } from "../dal";
import { dueDateIso, type invoiceInputSchema } from "../intake-validation";
import type { DocumentProvenance } from "../invoice-document/provenance";
import { appendLedgerEntry } from "../ledger";
import type { OriginalBill } from "../shadow-bills";

/** An invoice as the form's schema accepts it. */
export type InvoiceInput = z.output<typeof invoiceInputSchema>;

/**
 * Adds one invoice: the row, and the `create_invoice` entry that says who added it, and where it came from when it
 * was read from a document (invoice from a document D8), added from the Telegram bot (Telegram bot design R10) or from
 * Slack, with the member's link (Slack design S15), from an invoice that arrived by email, with its inbox row (email
 * invoices design E8), or added through the API with a key (write API R4). The one way an invoice is added, whether a person typed it into the
 * form, tapped Add on a draft the bot read, or their key sent it. A key's invoice is its issuer's, and nobody's once
 * the issuer's account is gone, as an invoice whose maker deleted their account is. Runs
 * inside the organization's scope; the counterparty is looked up there, so another organization's id is not found,
 * exactly like one that does not exist, and then nothing is written.
 */
export async function createInvoice(input: {
  actorId: string | null;
  invoice: InvoiceInput;
  document: DocumentProvenance | null;
  via?: "telegram" | "slack" | "email" | "api";
  /** The key that sent it, when it came through the API. */
  apiKeyId?: string;
  /** The member's Slack link, when it was added from Slack (Slack design S15). */
  linkId?: string;
  /** The inbox row it was read from, when it arrived by email (email invoices design E8). */
  inboxEmailId?: string;
  /** The bill as written in the business's own currency, when it was converted to USDC in shadow mode (shadow mode S6). */
  original?: OriginalBill;
}): Promise<{ id: string; counterpartyName: string } | null> {
  const { actorId, invoice, document, via, apiKeyId, linkId, inboxEmailId, original } = input;
  const lookup = await db()
    .from("counterparties")
    .select("id, name")
    .eq("id", invoice.counterpartyId)
    .maybeSingle<{ id: string; name: string }>();
  if (lookup.error) throw new Error(lookup.error.message);
  const counterparty = lookup.data;
  if (!counterparty) return null;

  const row = unwrap(
    await db()
      .from("invoices")
      .insert({
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
      })
      .select("id")
      .single<{ id: string }>()
  );

  await appendLedgerEntry({
    actor: "human",
    domain: invoice.direction === "payable" ? "ap" : "ar",
    action: "create_invoice",
    summary: `Added ${invoice.direction} invoice for ${counterparty.name}: ${invoice.amount} ${invoice.currency}${original ? ` (${original.amount} ${original.currency})` : ""}`,
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
      ...(document ? { document } : {}),
      ...(via ? { via } : {}),
      ...(apiKeyId ? { apiKeyId } : {}),
      ...(linkId ? { linkId } : {}),
      ...(inboxEmailId ? { inboxEmailId } : {}),
      ...(original ? { bill: original } : {}),
    },
  });
  return { id: row.id, counterpartyName: counterparty.name };
}
