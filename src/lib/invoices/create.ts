import type { z } from "zod";
import { db, unwrap } from "../dal";
import { dueDateIso, type invoiceInputSchema } from "../intake-validation";
import type { DocumentProvenance } from "../invoice-document/provenance";
import { appendLedgerEntry } from "../ledger";

/** An invoice as the form's schema accepts it. */
export type InvoiceInput = z.output<typeof invoiceInputSchema>;

/**
 * Adds one invoice: the row, and the `create_invoice` entry that says who added it, and where it came from when it
 * was read from a document (invoice from a document D8) or added from the Telegram bot (Telegram bot design R10). The
 * one way an invoice is added, whether a person typed it into the form or tapped Add on a draft the bot read. Runs
 * inside the organization's scope; the counterparty is looked up there, so another organization's id is not found,
 * exactly like one that does not exist, and then nothing is written.
 */
export async function createInvoice(input: {
  actorId: string;
  invoice: InvoiceInput;
  document: DocumentProvenance | null;
  via?: "telegram";
}): Promise<{ id: string; counterpartyName: string } | null> {
  const { actorId, invoice, document, via } = input;
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
      })
      .select("id")
      .single<{ id: string }>()
  );

  await appendLedgerEntry({
    actor: "human",
    domain: invoice.direction === "payable" ? "ap" : "ar",
    action: "create_invoice",
    summary: `Added ${invoice.direction} invoice for ${counterparty.name}: ${invoice.amount} ${invoice.currency}`,
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
    },
  });
  return { id: row.id, counterpartyName: counterparty.name };
}
