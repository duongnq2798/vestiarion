import type { BookingRowView } from "@/lib/connectors/bookings-view";
import type { CrmRowView } from "@/lib/connectors/crm-review";
import type { ReviewRowView } from "@/lib/connectors/review";
import type { LedgerEntry } from "@/lib/ledger";
import type { PayLinkState } from "@/lib/platform/pay-links";
import type { CounterpartyRow, InvoiceRow } from "@/lib/queries";

/**
 * Bills & receivables' states for the redesign's pictures (docs/superpowers/specs/2026-10-12-bills-tabs-design.md,
 * docs/superpowers/specs/bills-tabs-shots/): a workspace on Monday, Oct 12, 2026 with dozens of bills, a held bill with no
 * purchase order, one code refused, overdue receivables and reviews waiting; and an empty one. Made up: no workspace has
 * these bills.
 */

export const BILLS_NOW = Date.UTC(2026, 9, 12, 9, 0);

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const counterparty = (n: number, name: string, over: Partial<CounterpartyRow> = {}): CounterpartyRow => ({
  id: uuid(1000 + n),
  name,
  role: "vendor",
  address: `0x${"c0ffee00".repeat(5)}`,
  // The payee is paid on the workspace's own chain: no chain of its own.
  chain: null,
  jurisdiction: "US",
  risk_level: "clear",
  risk_notes: null,
  payment_limit: 5000,
  baseline_payment_limit: 5000,
  last_screened_at: "2026-10-01T08:00:00Z",
  performance_score: null,
  performance_inputs: null,
  address_changed_at: null,
  address_confirmed_at: null,
  sample: false,
  purchase_order_required: true,
  ...over,
});

const VENDORS = [
  counterparty(1, "Northwind Hosting"),
  counterparty(2, "Brightline Media", { payment_limit: 500, baseline_payment_limit: 500 }),
  counterparty(3, "Kestrel Print"),
  counterparty(4, "Juniper Legal", { address: null, purchase_order_required: false }),
  counterparty(5, "Atlas Couriers"),
  counterparty(6, "Harbor Office Supply"),
  counterparty(7, "Cobalt Cloud", { purchase_order_required: false }),
  counterparty(8, "Meridian Facilities"),
  counterparty(9, "Orbit Telecom", { purchase_order_required: false }),
  counterparty(10, "Pinecrest Catering"),
  counterparty(11, "Quill & Co Stationery"),
  counterparty(12, "Summit Freight"),
];
const CLIENTS = [
  counterparty(21, "Acme Retail", { role: "client" }),
  counterparty(22, "Bluebird Cafe", { role: "client" }),
  counterparty(23, "Granite Labs", { role: "client" }),
  counterparty(24, "Lumen Health", { role: "client" }),
];
export const BILLS_COUNTERPARTIES: CounterpartyRow[] = [...VENDORS, ...CLIENTS];

const byName = (name: string) => BILLS_COUNTERPARTIES.find((row) => row.name === name) as CounterpartyRow;

let next = 0;
const invoice = (name: string, over: Partial<InvoiceRow> & Pick<InvoiceRow, "amount" | "due_date" | "status">): InvoiceRow => {
  next += 1;
  const party = byName(name);
  return {
    id: uuid(2000 + next),
    direction: party.role === "client" ? "receivable" : "payable",
    counterparty_id: party.id,
    counterparty_name: party.name,
    memo: null,
    po_reference: null,
    goods_received: true,
    agent_reasoning: null,
    tx_ref: null,
    scheduled_for: null,
    early_pay_discount_pct: null,
    discount_due_date: null,
    paid_amount: null,
    currency: "USDC",
    created_at: "2026-10-01T10:00:00Z",
    ...over,
  };
};

const paid = (name: string, amount: number, day: string, memo: string): InvoiceRow =>
  invoice(name, {
    amount,
    due_date: `${day}T00:00:00Z`,
    status: "paid",
    memo,
    po_reference: "PO-1100",
    tx_ref: `0x${"7a".repeat(31)}${String(next % 90 + 10)}`,
    paid_amount: amount,
    settled_at: `${day}T09:00:00Z`,
    agent_reasoning: `Paid ${amount.toFixed(2)} USDC to ${name}: the purchase order matches, the goods were received, and it is within the limit.`,
  });

export const HELD_NO_PO = invoice("Northwind Hosting", {
  amount: 1250,
  due_date: "2026-10-09T00:00:00Z",
  status: "held",
  memo: "INV-104 · Servers, October",
  goods_received: false,
  agent_reasoning: "There is no purchase order on file and the servers are not marked received, so the three-way match is incomplete: I hold it for a person.",
});
const REFUSED_LIMIT = invoice("Brightline Media", {
  amount: 2500,
  due_date: "2026-10-20T00:00:00Z",
  status: "flagged",
  memo: "BM-2207 · Campaign, Q4",
  po_reference: "PO-3301",
  agent_reasoning: "The purchase order matches and the work was received, so I would pay the 2,500.00 USDC invoice on its due date.",
});
const HELD_GOODS = invoice("Kestrel Print", {
  amount: 300,
  due_date: "2026-10-16T00:00:00Z",
  status: "held",
  memo: "KP-88 · Brochures",
  po_reference: "PO-0088",
  goods_received: false,
  agent_reasoning: "The purchase order is on file but the brochures are not marked received yet: I hold it until they are.",
});
const REFUSED_ADDRESS = invoice("Juniper Legal", {
  amount: 900,
  due_date: "2026-10-14T00:00:00Z",
  status: "flagged",
  memo: "Contract review, September",
  agent_reasoning: "Juniper Legal needs no purchase order and the work was received, so I would pay it on its due date.",
});

const UPCOMING: InvoiceRow[] = [
  invoice("Atlas Couriers", { amount: 180, due_date: "2026-10-13T00:00:00Z", status: "pending", memo: "AC-551 · Deliveries, week 41", po_reference: "PO-0551" }),
  invoice("Harbor Office Supply", { amount: 640, due_date: "2026-10-20T00:00:00Z", status: "scheduled", scheduled_for: "2026-10-14T00:00:00Z", memo: "HOS-2207 · Chairs", po_reference: "PO-2207", early_pay_discount_pct: "1", discount_due_date: "2026-10-14T00:00:00Z", agent_reasoning: "Scheduled for Oct 14, the discount's last day: 1% is worth more than holding the cash six days." }),
  invoice("Cobalt Cloud", { amount: 420, due_date: "2026-10-15T00:00:00Z", status: "scheduled", scheduled_for: "2026-10-15T00:00:00Z", memo: "October hosting", recurring_id: "rec-1", recurring_period: "2026-10-01", agent_reasoning: "Within the limit and needs no purchase order: scheduled for its due date." }),
  invoice("Meridian Facilities", { amount: 400, due_date: "2026-10-15T00:00:00Z", status: "scheduled", scheduled_for: "2026-10-15T00:00:00Z", memo: "MF-31 · Cleaning, October", po_reference: "PO-0031", currency: "EURC", agent_reasoning: "Paid in EURC from the EURC balance on its due date." }),
  invoice("Orbit Telecom", { amount: 89.9, due_date: "2026-10-18T00:00:00Z", status: "scheduled", scheduled_for: "2026-10-18T00:00:00Z", memo: "Phone lines, October", recurring_id: "rec-2", recurring_period: "2026-10-01", agent_reasoning: "A recurring bill within the limit: scheduled for its due date." }),
  invoice("Pinecrest Catering", { amount: 560, due_date: "2026-10-22T00:00:00Z", status: "pending", memo: "PC-77 · Offsite lunch", po_reference: "PO-0077" }),
  invoice("Quill & Co Stationery", { amount: 75.5, due_date: "2026-10-23T00:00:00Z", status: "scheduled", scheduled_for: "2026-10-23T00:00:00Z", memo: "Q-1203 · Paper", po_reference: "PO-1203", agent_reasoning: "Scheduled for its due date." }),
  invoice("Summit Freight", { amount: 1340, due_date: "2026-10-24T00:00:00Z", status: "scheduled", scheduled_for: "2026-10-24T00:00:00Z", memo: "SF-908 · Freight, Rotterdam", po_reference: "PO-0908", agent_reasoning: "Scheduled for its due date." }),
  invoice("Northwind Hosting", { amount: 1250, due_date: "2026-10-28T00:00:00Z", status: "scheduled", scheduled_for: "2026-10-28T00:00:00Z", memo: "INV-118 · Servers, November", po_reference: "PO-0118", agent_reasoning: "Scheduled for its due date." }),
  invoice("Atlas Couriers", { amount: 210, due_date: "2026-10-30T00:00:00Z", status: "pending", memo: "AC-563 · Deliveries, week 43", po_reference: "PO-0563" }),
  invoice("Cobalt Cloud", { amount: 420, due_date: "2026-11-15T00:00:00Z", status: "pending", memo: "November hosting", recurring_id: "rec-1", recurring_period: "2026-11-01" }),
  invoice("Harbor Office Supply", { amount: 95, due_date: "2026-11-02T00:00:00Z", status: "scheduled", scheduled_for: "2026-11-02T00:00:00Z", memo: "HOS-2215 · Toner", po_reference: "PO-2215", agent_reasoning: "Scheduled for its due date." }),
];

const PAID: InvoiceRow[] = [
  paid("Atlas Couriers", 175, "2026-10-06", "AC-540 · Deliveries, week 40"),
  paid("Cobalt Cloud", 420, "2026-10-01", "September hosting"),
  paid("Northwind Hosting", 1250, "2026-09-30", "INV-097 · Servers, September"),
  paid("Orbit Telecom", 89.9, "2026-09-18", "Phone lines, September"),
  paid("Harbor Office Supply", 312.4, "2026-09-25", "HOS-2190 · Desks"),
  paid("Pinecrest Catering", 230, "2026-09-24", "PC-70 · Team lunch"),
  paid("Summit Freight", 980, "2026-09-22", "SF-880 · Freight, Hamburg"),
  paid("Quill & Co Stationery", 64, "2026-09-20", "Q-1190 · Paper"),
  paid("Kestrel Print", 410, "2026-09-19", "KP-80 · Posters"),
  paid("Meridian Facilities", 380, "2026-09-15", "MF-30 · Cleaning, September"),
  paid("Atlas Couriers", 160, "2026-09-29", "AC-532 · Deliveries, week 39"),
  paid("Brightline Media", 450, "2026-09-12", "BM-2190 · Social, September"),
  paid("Juniper Legal", 600, "2026-09-10", "Trademark filing"),
  paid("Cobalt Cloud", 420, "2026-09-01", "August hosting"),
  paid("Northwind Hosting", 1250, "2026-08-31", "INV-089 · Servers, August"),
  paid("Orbit Telecom", 89.9, "2026-08-18", "Phone lines, August"),
  paid("Summit Freight", 1120, "2026-08-25", "SF-861 · Freight, Antwerp"),
  paid("Harbor Office Supply", 58, "2026-08-21", "HOS-2170 · Toner"),
  paid("Pinecrest Catering", 310, "2026-08-27", "PC-64 · Client dinner"),
  paid("Kestrel Print", 125, "2026-08-14", "KP-74 · Cards"),
  paid("Atlas Couriers", 190, "2026-09-15", "AC-520 · Deliveries, week 37"),
  paid("Quill & Co Stationery", 42, "2026-08-11", "Q-1172 · Pens"),
];

export const OVERDUE_RECEIVABLE = invoice("Acme Retail", { amount: 1800, due_date: "2026-10-03T00:00:00Z", status: "pending", memo: "INV-1042 · October retainer" });
const RECEIVABLES: InvoiceRow[] = [
  OVERDUE_RECEIVABLE,
  invoice("Bluebird Cafe", { amount: 640, due_date: "2026-10-08T00:00:00Z", status: "pending", memo: "INV-1050 · Menu design" }),
  invoice("Granite Labs", { amount: 3000, due_date: "2026-10-25T00:00:00Z", status: "pending", memo: "INV-1058 · Website rebuild, deposit" }),
  invoice("Lumen Health", { amount: 1200, due_date: "2026-10-30T00:00:00Z", status: "pending", memo: "INV-1061 · Brand guide" }),
  invoice("Acme Retail", { amount: 1800, due_date: "2026-09-03T00:00:00Z", status: "received", memo: "INV-1031 · September retainer", settled_at: "2026-09-04T10:00:00Z", tx_ref: `0x${"3b".repeat(32)}` }),
  invoice("Bluebird Cafe", { amount: 520, due_date: "2026-09-12T00:00:00Z", status: "received", memo: "INV-1033 · Logo", settled_at: "2026-09-11T10:00:00Z", tx_ref: `0x${"3c".repeat(32)}` }),
  invoice("Lumen Health", { amount: 950, due_date: "2026-09-20T00:00:00Z", status: "received", memo: "INV-1037 · Workshop", settled_at: "2026-09-21T10:00:00Z", tx_ref: `0x${"3d".repeat(32)}` }),
];

/** Every invoice of the busy workspace, as `listInvoices` reads them: by due date. */
export const BILLS_INVOICES: InvoiceRow[] = [HELD_NO_PO, REFUSED_LIMIT, HELD_GOODS, REFUSED_ADDRESS, ...UPCOMING, ...PAID, ...RECEIVABLES].sort((a, b) => a.due_date.localeCompare(b.due_date));

const entry = (seq: number, invoiceRow: InvoiceRow, ts: string, detail: Record<string, unknown>): LedgerEntry => ({
  seq,
  id: `bills-shot-${seq}`,
  ts,
  actor: "agent",
  domain: "ap",
  action: "ap_pay",
  summary: `PAY invoice from ${invoiceRow.counterparty_name}`,
  detail: { invoiceId: invoiceRow.id, decisionMode: "llm", decision: { action: "pay" }, ...detail },
  prevHash: "0".repeat(64),
  hash: String(seq).padStart(64, "a"),
  bodyHash: String(seq).padStart(64, "b"),
  signature: null,
  signingKeyId: null,
}) as unknown as LedgerEntry;

/** The decisions code refused, and the holds the agent recorded with their facts: newest first, as the ledger answers. */
export const BILLS_ENTRIES: LedgerEntry[] = [
  entry(5104, REFUSED_ADDRESS, "2026-10-12T08:40:00Z", {
    guardrailBlocked: true,
    guardrailRule: "counterparty.no_address",
    observed: { riskLevel: "clear", paymentLimit: 5000, poReference: null, goodsReceived: true },
  }),
  entry(5103, REFUSED_LIMIT, "2026-10-12T08:39:00Z", {
    guardrailBlocked: true,
    guardrailRule: "counterparty.payment_limit",
    observed: { riskLevel: "clear", paymentLimit: 500, poReference: "PO-3301", goodsReceived: true },
  }),
  entry(5102, HELD_GOODS, "2026-10-12T08:38:00Z", { decision: { action: "hold" }, observed: { riskLevel: "clear", paymentLimit: 5000, poReference: "PO-0088", goodsReceived: false } }),
  entry(5101, HELD_NO_PO, "2026-10-09T08:30:00Z", { decision: { action: "hold" }, observed: { riskLevel: "clear", paymentLimit: 5000, poReference: null, goodsReceived: false } }),
];

/** The overdue receivable's pay link, with two reminders sent. */
export const BILLS_LINKS = new Map<string, PayLinkState>([
  [OVERDUE_RECEIVABLE.id, { url: "https://www.vestiarion.xyz/pay/acme-1042", legacy: false, remindersOnAt: "2026-10-01T08:00:00Z", deferredUntil: null, sent: [{ number: 1, tone: "friendly", sentAt: "2026-10-04T09:00:00Z" }, { number: 2, tone: "firm", sentAt: "2026-10-10T09:00:00Z" }] } as PayLinkState],
]);

const reviewRow = (n: number, supplier: string, number: string, amount: string, dueOn: string, supplierNew = false): ReviewRowView => ({
  id: uuid(3000 + n),
  supplier,
  supplierNew,
  number,
  amount,
  currency: "USD",
  usdc: null,
  dueOn,
  status: "add",
  reason: null,
});

/** Six bills Xero brought in, two of them large: none is added until a person ticks it. */
export const XERO_ITEMS: ReviewRowView[] = [
  reviewRow(1, "PowerDirect Ltd", "PD-4471", "2500", "2026-10-28"),
  reviewRow(2, "City Water", "CW-1180", "84.20", "2026-10-21"),
  reviewRow(3, "Office Mart", "OM-3391", "312.00", "2026-10-25", true),
  reviewRow(4, "Hoang Electrical", "HE-77", "2500", "2026-11-02", true),
  reviewRow(5, "Paper Plus", "PP-1021", "46.90", "2026-10-19"),
  reviewRow(6, "Swift Courier", "SC-882", "128.00", "2026-10-23"),
];
export const QUICKBOOKS_ITEMS: ReviewRowView[] = [reviewRow(7, "Hicks Hardware", "HH-301", "640.00", "2026-10-26"), reviewRow(8, "Bay Signs", "BS-17", "220.00", "2026-10-30", true)];

export const XERO_BOOKING: BookingRowView = {
  id: uuid(3101),
  state: "draft",
  supplier: "Atlas Couriers",
  billNumber: "AC-540",
  amount: "175",
  currency: "USD",
  paidOn: "2026-10-06",
  reference: `0x${"7a".repeat(32)}`,
  account: "Arc USDC wallet (091)",
  billNow: { amountDue: "175", status: "open" },
  billAfter: { amountDue: "0.00", status: "paid" },
  network: "arc-testnet",
  shadow: false,
  paidAmount: "175",
  paidToken: "USDC",
  networkFee: "0.01",
  fingerprint: "bills-shot",
  blocked: null,
  words: "Ready to book",
  paymentId: null,
};

/** One won deal in HubSpot to plan. */
export const HUBSPOT_WON: CrmRowView[] = [
  { id: uuid(3201), name: "Website rebuild", company: "Granite Labs", amount: "12,000 USD", closeOn: "2026-10-01", stage: "Closed Won", plan: { ok: true }, linkedDeal: null, changes: [] } as CrmRowView,
];
