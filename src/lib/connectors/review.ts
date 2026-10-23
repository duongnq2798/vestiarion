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
    // An accounting tool's bill carries no late fee Vestiarion reads (late fees LF2).
    lateFee: null,
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

/** A bill of the review list, as the browser shows it: no id of the provider's, no token. */
export interface ReviewRowView {
  id: string;
  supplier: string;
  /** The supplier is added as a new counterparty with the bill. */
  supplierNew: boolean;
  number: string | null;
  /** What is left to pay: the amount it is added at, in its own currency. */
  amount: string;
  /** The bill's whole total: more than `amount` when it was partly paid in the tool (QuickBooks Q9). Absent: `amount`. */
  total?: string;
  currency: string;
  /** The USDC it is added at, for a bill in the business's own currency. */
  usdc: string | null;
  dueOn: string | null;
  status: RowFate["status"];
  reason: string | null;
}

/** A bill already added that the provider since says was paid, voided or deleted (X10). */
export interface ClosedRowView {
  id: string;
  supplier: string;
  number: string | null;
  sourceStatus: SourceStatus;
}

/**
 * A bill already added whose amount due at the provider fell below the figure it was added at: partly paid there since
 * (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q9). `left` is what the provider says is due now,
 * `added` the invoice's own figure, both in the bill's currency.
 */
export interface PartlyPaidRowView {
  id: string;
  supplier: string;
  number: string | null;
  currency: string;
  left: string;
  added: string;
}

export type ReviewView =
  | { state: "hidden" }
  | {
      state: "list";
      connectionId: string;
      label: string;
      organisation: string | null;
      items: ReviewRowView[];
      closed: ClosedRowView[];
      partlyPaid: PartlyPaidRowView[];
    };

export function reviewRowView(item: ReviewItem): ReviewRowView {
  return {
    id: item.bill.id,
    supplier: item.supplier.name,
    supplierNew: item.supplier.kind === "new",
    number: item.bill.number,
    amount: item.bill.amountDue,
    total: item.bill.total,
    currency: item.bill.currency,
    usdc: item.fate.usdc,
    dueOn: item.bill.dueOn,
    status: item.fate.status,
    reason: item.fate.status === "add" ? null : item.fate.reason,
  };
}

/** An invoice a bill became, with the figure it was added at. */
export interface AddedInvoice {
  id: string;
  amount: number | string;
  currency: string;
  original_amount: number | string | null;
  original_currency: string | null;
  status: string;
}

/** An added bill still open at the provider, with what it says is due now. */
export interface AddedBill {
  id: string;
  external_id: string;
  contact_name: string;
  number: string | null;
  currency: string;
  total: number | string;
  amount_due: number | string;
}

/** The figure an invoice was added at, in the bill's own currency: its original in shadow mode, else its amount. */
function addedFigure(invoice: AddedInvoice, currency: string): number | null {
  if (invoice.original_currency === currency && invoice.original_amount !== null) return Number(invoice.original_amount);
  return invoice.currency === currency ? Number(invoice.amount) : null;
}

/**
 * The added bills partly paid at the provider since (Q9): an invoice not yet paid or rejected, added at more than the
 * provider says is due now. Pure.
 */
export function partlyPaidSince(bills: readonly AddedBill[], invoiceOf: ReadonlyMap<string, AddedInvoice>): PartlyPaidRowView[] {
  return bills.flatMap((bill): PartlyPaidRowView[] => {
    const invoice = invoiceOf.get(bill.external_id);
    if (!invoice || invoice.status === "paid" || invoice.status === "rejected") return [];
    const added = addedFigure(invoice, bill.currency);
    const left = Number(bill.amount_due);
    // Within a millionth: the amounts are exact decimals of at most six places.
    if (added === null || !(left < added - 1e-7)) return [];
    return [{ id: bill.id, supplier: bill.contact_name, number: bill.number, currency: bill.currency, left: String(left), added: String(added) }];
  });
}

/** The added bills still open at the provider that it says were partly paid since they were added. */
async function readPartlyPaid(connection: Connection): Promise<PartlyPaidRowView[]> {
  const added = (unwrap(
    await db()
      .from("accounting_bills")
      .select("id, external_id, contact_name, number, currency, total, amount_due")
      .eq("connection_id", connection.id)
      .eq("review_state", "added")
      .eq("source_status", "open")
      .order("changed_at", { ascending: false })
      .limit(50)
  ) as AddedBill[]).filter((bill) => Number(bill.amount_due) < Number(bill.total));
  if (added.length === 0) return [];
  const links = unwrap(
    await db()
      .from("external_links")
      .select("external_id, local_id")
      .eq("connection_id", connection.id)
      .eq("object_type", "bill")
      .in("external_id", added.map((bill) => bill.external_id))
      .not("local_id", "is", null)
  ) as Array<{ external_id: string; local_id: string }>;
  if (links.length === 0) return [];
  const invoices = unwrap(
    await db().from("invoices").select("id, amount, currency, original_amount, original_currency, status").in("id", links.map((link) => link.local_id))
  ) as AddedInvoice[];
  const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const invoiceOf = new Map(links.flatMap((link) => (byId.has(link.local_id) ? [[link.external_id, byId.get(link.local_id) as AddedInvoice]] : [])));
  return partlyPaidSince(added, invoiceOf);
}

/** The review list on Bills & receivables: hidden before migration 0101, without a connection, or once disconnected. */
export async function accountingReview(connection: Connection | null): Promise<ReviewView> {
  if (!connection || connection.status === "revoked") return { state: "hidden" };
  const [items, closed, partlyPaid] = await Promise.all([
    readReview(connection),
    db()
      .from("accounting_bills")
      .select("id, contact_name, number, source_status")
      .eq("connection_id", connection.id)
      .eq("review_state", "added")
      .in("source_status", ["paid", "voided", "deleted"])
      .order("changed_at", { ascending: false })
      .limit(20),
    readPartlyPaid(connection),
  ]);
  const closedRows = (unwrap(closed) as Array<{ id: string; contact_name: string; number: string | null; source_status: SourceStatus }>).map((row) => ({
    id: row.id,
    supplier: row.contact_name,
    number: row.number,
    sourceStatus: row.source_status,
  }));
  return {
    state: "list",
    connectionId: connection.id,
    label: PROVIDER_LABELS[connection.provider],
    organisation: connection.externalOrgName,
    items: items.map(reviewRowView),
    closed: closedRows,
    partlyPaid,
  };
}
