import { createHash } from "node:crypto";
import { conversions, importWorkspace, possibleDuplicates } from "../bill-import/check";
import { readAmount } from "../bill-import/amounts";
import { acceptedCurrencies, counterpartyFor, fatesOf, memoWithInvoiceNumber, notTaken, type ImportWorkspace, type ReadRow, type RowFate } from "../bill-import/rows";
import { db, unwrap } from "../dal";
import type { Connection } from "./connections";
import { PROVIDER_LABELS, type SourceStatus } from "./provider";
import type { ReviewState } from "./bills";

/**
 * Bills from an accounting provider through a bill list's own check (docs/superpowers/specs/2026-10-12-xero-connector-design.md
 * X11). Each bill in review is read as a row of a list (`ReadRow`) and given its fate by `fatesOf`, with the facts
 * `checkBillList` reads: the counterparties, the invoices it could repeat, shadow mode and the day's rates. So the
 * duplicates rule, the currency rules (USDC and EURC outside shadow mode, the business's own currency in it, never
 * VND), the currency's decimals and the invoice form's own schema are the import's, word for word. The supplier is the
 * counterparty its contact is linked to, else the one with its name, else a new one, added with the bill.
 */

/** A bill kept for review, as the panel and the command read it. */
export interface StagedBillView {
  id: string;
  connectionId: string;
  externalId: string;
  contactExternalId: string | null;
  contactName: string;
  number: string | null;
  reference: string | null;
  currency: string;
  total: string;
  amountDue: string;
  issuedOn: string | null;
  dueOn: string | null;
  sourceStatus: SourceStatus;
  reviewState: ReviewState;
  firstSeenAt: string;
}

export type Supplier =
  | { kind: "linked" | "matched"; counterpartyId: string; name: string }
  /** No counterparty has the name: one is added with the bill. `counterpartyId` is a placeholder until then. */
  | { kind: "new"; counterpartyId: string; name: string }
  | { kind: "ambiguous"; name: string };

export interface ReviewItem {
  bill: StagedBillView;
  supplier: Supplier;
  fate: RowFate;
}

/** A stable id, shaped as a UUID, standing for a supplier not yet added: the same name gives the same one. */
export function placeholderId(name: string): string {
  const hex = createHash("sha256").update(`new-supplier:${name.trim().toLowerCase()}`, "utf8").digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function supplierOf(
  bill: Pick<StagedBillView, "contactExternalId" | "contactName">,
  links: ReadonlyMap<string, string>,
  counterparties: ReadonlyArray<{ id: string; name: string }>
): Supplier {
  const linkedId = bill.contactExternalId ? links.get(bill.contactExternalId) : undefined;
  const linked = linkedId ? counterparties.find((counterparty) => counterparty.id === linkedId) : undefined;
  if (linked) return { kind: "linked", counterpartyId: linked.id, name: linked.name };
  const match = counterpartyFor(bill.contactName, counterparties);
  if (typeof match !== "string") return { kind: "matched", counterpartyId: match.id, name: match.name };
  if (/matches more than one/.test(match)) return { kind: "ambiguous", name: bill.contactName };
  return { kind: "new", counterpartyId: placeholderId(bill.contactName), name: bill.contactName };
}

const MAX_MEMO = 280;

/** The bill's number first, then its reference, cut to the form's 280 characters. */
function memoOf(number: string | null, reference: string | null): string | null {
  const full = memoWithInvoiceNumber(number, reference);
  if (!full || full.length <= MAX_MEMO) return full;
  return `${full.slice(0, MAX_MEMO - 1)}…`;
}

/** A bill as a row of a list of payables, with what the list's own reading would say is wrong with it. */
export function reviewRow(bill: StagedBillView, index: number, supplier: Supplier, workspace: ImportWorkspace, goodsReceived: boolean, label: string): ReadRow {
  const problems: string[] = [];
  let amount: string | null = null;
  if (!acceptedCurrencies(workspace).includes(bill.currency)) {
    problems.push(notTaken(bill.currency, workspace));
  } else {
    const read = readAmount(bill.amountDue, ".", bill.currency);
    if (read.ok) amount = read.value;
    else problems.push(`Amount due “${bill.amountDue}” ${read.reason}.`);
  }
  if (!bill.dueOn) problems.push(`No due date in ${label}.`);
  return {
    line: index + 1,
    cells: [],
    problems,
    counterparty: supplier.name,
    direction: "payable",
    amount,
    currency: bill.currency,
    dueDate: bill.dueOn,
    invoiceNumber: bill.number,
    poReference: null,
    memo: memoOf(bill.number, bill.reference),
    goodsReceived,
    discountPct: null,
    discountDeadline: null,
  };
}

/** Each bill with its supplier and fate; a bill the list repeats is named by its number rather than a row. */
export function reviewItems(bills: readonly StagedBillView[], suppliers: readonly Supplier[], fates: readonly RowFate[], label: string): ReviewItem[] {
  return bills.map((bill, index) => {
    const fate = fates[index];
    if (fate.status === "duplicate" && fate.sameAsLine !== null) {
      const earlier = bills[fate.sameAsLine - 1];
      return { bill, supplier: suppliers[index], fate: { ...fate, reason: `Same as bill ${earlier?.number ?? "above"} from ${label}.` } };
    }
    return { bill, supplier: suppliers[index], fate };
  });
}

/** A new supplier's payment limit: the largest USDC amount of its bills being added, to the cent, rounded up. */
export function newSupplierLimit(fates: readonly RowFate[], placeholder: string): string {
  const largest = fates.reduce((max, fate) => (fate.status === "add" && fate.counterpartyId === placeholder ? Math.max(max, Number(fate.invoice.amount)) : max), 0);
  return (Math.ceil(largest * 100) / 100).toFixed(2);
}

interface BillRow {
  id: string;
  connection_id: string;
  external_id: string;
  contact_external_id: string | null;
  contact_name: string;
  number: string | null;
  reference: string | null;
  currency: string;
  total: number | string;
  amount_due: number | string;
  issued_on: string | null;
  due_on: string | null;
  source_status: SourceStatus;
  review_state: ReviewState;
  first_seen_at: string;
}

export const BILL_COLUMNS =
  "id, connection_id, external_id, contact_external_id, contact_name, number, reference, currency, total, amount_due, issued_on, due_on, source_status, review_state, first_seen_at";

export function toStagedBill(row: BillRow): StagedBillView {
  return {
    id: row.id,
    connectionId: row.connection_id,
    externalId: row.external_id,
    contactExternalId: row.contact_external_id,
    contactName: row.contact_name,
    number: row.number,
    reference: row.reference,
    currency: row.currency,
    total: String(Number(row.total)),
    amountDue: String(Number(row.amount_due)),
    issuedOn: row.issued_on ? String(row.issued_on).slice(0, 10) : null,
    dueOn: row.due_on ? String(row.due_on).slice(0, 10) : null,
    sourceStatus: row.source_status,
    reviewState: row.review_state,
    firstSeenAt: row.first_seen_at,
  };
}

/** The most bills the review list shows, and adds at once: a bill list's own limit. */
export const MAX_REVIEW = 200;

/**
 * The connection's bills waiting for a person, or the ones named, each with its fate as the import would give it now.
 * Read in the workspace's scope; writes nothing.
 */
export async function readReview(connection: Connection, options: { ids?: readonly string[]; goodsReceived?: boolean } = {}): Promise<ReviewItem[]> {
  let query = db()
    .from("accounting_bills")
    .select(BILL_COLUMNS)
    .eq("connection_id", connection.id)
    .eq("review_state", "review")
    .eq("source_status", "open");
  if (options.ids) query = query.in("id", [...options.ids]);
  const bills = (unwrap(await query.order("due_on", { ascending: true, nullsFirst: false }).limit(MAX_REVIEW)) as BillRow[]).map(toStagedBill);
  if (bills.length === 0) return [];

  const [links, counterparties, workspace] = await Promise.all([
    db().from("external_links").select("external_id, local_id").eq("connection_id", connection.id).eq("object_type", "contact").not("local_id", "is", null),
    db().from("counterparties").select("id, name"),
    importWorkspace(),
  ]);
  const linked = new Map((unwrap(links) as Array<{ external_id: string; local_id: string }>).map((row) => [row.external_id, row.local_id]));
  const known = unwrap(counterparties) as Array<{ id: string; name: string }>;
  const suppliers = bills.map((bill) => supplierOf(bill, linked, known));
  const placeholders = new Map(suppliers.flatMap((supplier) => (supplier.kind === "new" ? [[supplier.counterpartyId, { id: supplier.counterpartyId, name: supplier.name }]] : [])));
  const everyone = [...known, ...placeholders.values()];
  const label = PROVIDER_LABELS[connection.provider];
  const rows = bills.map((bill, index) => reviewRow(bill, index, suppliers[index], workspace, options.goodsReceived ?? false, label));
  const fates = fatesOf(rows, {
    counterparties: everyone,
    existing: await possibleDuplicates(rows, everyone),
    conversions: await conversions(rows, workspace),
  });
  return reviewItems(bills, suppliers, fates, label);
}
