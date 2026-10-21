import { db as orgScopedDb } from "./dal";

export { invoiceAskedFor, payToDiffers } from "./invoice-pay-to-rules";

/**
 * The address an invoice's document asked to be paid to, against the counterparty's on file
 * (docs/superpowers/specs/2026-10-21-invoice-pay-to-hold-design.md IP1, IP2). The agent never pays the document's address:
 * it holds a payment whose document asked for another, until a person decides.
 */

/** Ids per `in` filter, to keep each request's address short. */
const ID_CHUNK = 100;

/**
 * The addresses the given invoices' documents asked to be paid to, by invoice id: those that named one. None before
 * migration 0136, when the column is not there; any other failure throws, so a stage that needs it stops rather than
 * pays past it.
 */
export async function readDocumentPayTo(
  invoiceIds: readonly string[],
  db: Pick<ReturnType<typeof orgScopedDb>, "from"> = orgScopedDb()
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let start = 0; start < invoiceIds.length; start += ID_CHUNK) {
    const chunk = invoiceIds.slice(start, start + ID_CHUNK);
    const read = await db.from("invoices").select("id, document_pay_to").in("id", chunk).not("document_pay_to", "is", null);
    if (read.error) {
      if (read.error.code === "42703" || read.error.code === "PGRST204") return new Map();
      throw new Error(`the invoices' document addresses could not be read: ${read.error.message}`);
    }
    const rows = Array.isArray(read.data) ? (read.data as Array<{ id: string; document_pay_to?: string | null }>) : [];
    for (const row of rows) {
      if (row.document_pay_to) found.set(row.id, row.document_pay_to);
    }
  }
  return found;
}
