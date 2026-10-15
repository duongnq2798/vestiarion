import { findDuplicates, type InvoiceLike } from "../agent/duplicates";
import { nameKey } from "../invoice-document/match";

/**
 * Whether a captured draft repeats something already in the workspace (invoice capture design C7), said before a
 * person adds it: the agent's own duplicate check (`findDuplicates`) against the bills of the counterparty chosen, a
 * bill of that counterparty that already names the invoice number, and another captured draft with the same supplier
 * and invoice number. Pure: the caller reads the rows. Each finding is a sentence a person reads.
 */

export interface DraftLike {
  id: string;
  counterpartyId: string | null;
  supplierName: string | null;
  invoiceNumber: string | null;
  amount: string | null;
  currency: string | null;
  dueDate: string | null;
  memo: string | null;
  poReference: string | null;
}

export interface BillRow {
  id: string;
  counterparty_id: string;
  amount: number | string;
  currency: string | null;
  memo: string | null;
  po_reference: string | null;
  due_date: string;
  status: string;
}

export interface OtherDraft {
  id: string;
  state: string;
  supplier_name: string | null;
  invoice_number: string | null;
  captured_at: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Oct 15". */
function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function draftDuplicates(draft: DraftLike, bills: BillRow[], otherDrafts: OtherDraft[]): string[] {
  const found: string[] = [];
  const amount = draft.amount !== null ? Number(draft.amount) : NaN;
  const ofCounterparty = draft.counterpartyId ? bills.filter((bill) => bill.counterparty_id === draft.counterpartyId) : [];

  if (draft.counterpartyId && Number.isFinite(amount) && draft.dueDate) {
    const like: InvoiceLike = {
      id: `draft-${draft.id}`,
      counterpartyId: draft.counterpartyId,
      amount,
      currency: draft.currency ?? "USDC",
      memo: draft.memo,
      poReference: draft.poReference,
      dueDate: draft.dueDate,
      status: "pending",
    };
    const candidates: InvoiceLike[] = ofCounterparty.map((bill) => ({
      id: bill.id,
      counterpartyId: bill.counterparty_id,
      amount: Number(bill.amount),
      currency: bill.currency ?? "USDC",
      memo: bill.memo,
      poReference: bill.po_reference,
      dueDate: bill.due_date,
      status: bill.status,
    }));
    for (const match of findDuplicates(like, candidates)) found.push(match.explanation);
  }

  const number = draft.invoiceNumber?.trim();
  if (number) {
    const names = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(number)}(?![A-Za-z0-9])`, "i");
    for (const bill of ofCounterparty) {
      if (bill.memo && names.test(bill.memo)) {
        found.push(`A bill of ${Number(bill.amount)} ${bill.currency ?? "USDC"} due ${bill.due_date.slice(0, 10)} already names invoice ${number}.`);
      }
    }
    const supplier = draft.supplierName ? nameKey(draft.supplierName) : "";
    for (const other of otherDrafts) {
      if (other.id === draft.id || other.state === "discarded" || other.state === "draft") continue;
      if (other.invoice_number?.trim().toLowerCase() !== number.toLowerCase()) continue;
      if (supplier && other.supplier_name && nameKey(other.supplier_name) !== supplier) continue;
      found.push(
        other.state === "confirmed"
          ? `Invoice ${number} was captured on ${shortDay(other.captured_at)} and already added as a bill.`
          : `Invoice ${number} was also captured on ${shortDay(other.captured_at)} and waits for review.`
      );
    }
  }
  return [...new Set(found)];
}
