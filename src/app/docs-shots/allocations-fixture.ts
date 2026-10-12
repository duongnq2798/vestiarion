import type { AllocationBook } from "@/lib/allocations/book";
import { toMicros, type AllocationRow, type PaymentIn, type ReceivableIn } from "@/lib/allocations/model";
import type { Customer } from "@/lib/allocations/suggest";
import { applyPaymentsView, receivableViews, type PaymentView, type ReceivableView } from "@/lib/allocations/view";
import type { InvoiceRow } from "@/lib/queries";

/**
 * The guide to applying money received (docs/superpowers/specs/2026-10-12-allocations-design.md): a live workspace on
 * Arc testnet whose clients paid three invoices with one transfer, paid one a few cents short, and paid half of
 * another, built by the real model and suggestions. Made up: no workspace has these clients, payments or addresses.
 */

const ACME = { id: "00000000-0000-4000-8000-00000000a0c1", name: "Acme Retail", address: `0x${"ac3e".repeat(10)}` };
const BEACON = { id: "00000000-0000-4000-8000-00000000a0c2", name: "Beacon Labs", address: `0x${"bea0".repeat(10)}` };
const CUSTOMERS: Customer[] = [ACME, BEACON];

const id = (n: number) => `00000000-0000-4000-8000-00000000a${String(n).padStart(3, "0")}`;
const receivable = (n: number, client: typeof ACME, amount: number, memo: string, dueDate: string, status = "pending"): ReceivableIn => ({
  id: id(n),
  counterpartyId: client.id,
  customer: client.name,
  amount: toMicros(amount),
  currency: "USDC",
  status,
  dueDate: `${dueDate}T12:00:00Z`,
  createdAt: "2026-09-20T09:00:00Z",
  memo,
  poReference: null,
});

const RECEIVABLES: ReceivableIn[] = [
  receivable(101, ACME, 1200, "INV-1040 Retainer", "2026-10-01"),
  receivable(102, ACME, 450, "INV-1041 Photos", "2026-10-05"),
  receivable(103, ACME, 350, "INV-1042 Prints", "2026-10-08"),
  receivable(104, BEACON, 800, "INV-1050 Workshop", "2026-10-09"),
  receivable(105, BEACON, 2400, "INV-1051 Website build", "2026-10-20"),
];

const payment = (n: number, client: typeof ACME | null, amount: number, receivedAt: string): PaymentIn => ({
  id: id(200 + n),
  circleTxId: `docs-circle-${n}`,
  txHash: `0x${String(n).repeat(2)}${"5af3".repeat(15)}`,
  from: client ? client.address : `0x${"7e57".repeat(10)}`,
  amount: toMicros(amount),
  currency: "USDC",
  receivedAt,
  wholeMatch: null,
});

const PAYMENTS: PaymentIn[] = [
  payment(1, ACME, 2000, "2026-10-12T08:41:00Z"),
  payment(2, BEACON, 799.6, "2026-10-11T15:12:00Z"),
  payment(3, BEACON, 1200, "2026-10-10T10:03:00Z"),
  payment(4, null, 20, "2026-10-09T07:30:00Z"),
];

/** Half of the website build, applied the day it arrived. */
const ROWS: AllocationRow[] = [
  {
    id: id(301),
    kind: "payment",
    invoiceId: id(105),
    transferId: id(203),
    amount: toMicros(1200),
    currency: "USDC",
    reverses: null,
    reason: null,
    basis: "person",
    paymentSeq: 1,
    createdBy: "00000000-0000-4000-8000-0000000000a1",
    createdAt: "2026-10-10T10:20:00Z",
  },
];

const BOOK: AllocationBook = { available: true, rows: ROWS, payments: PAYMENTS, floatSenders: new Set() };

export const APPLY_PAYMENTS: PaymentView[] = applyPaymentsView(BOOK, RECEIVABLES, CUSTOMERS);

const views = receivableViews(BOOK, RECEIVABLES);
export const PART_PAID_VIEW: ReceivableView = views.get(id(105)) as ReceivableView;

/** The website build, as Bills & receivables lists it. */
export const PART_PAID: InvoiceRow = {
  id: id(105),
  direction: "receivable",
  counterparty_id: BEACON.id,
  counterparty_name: BEACON.name,
  amount: 2400,
  memo: "INV-1051 Website build",
  po_reference: null,
  goods_received: false,
  due_date: "2026-10-20",
  status: "pending",
  agent_reasoning: null,
  tx_ref: null,
  scheduled_for: null,
  early_pay_discount_pct: null,
  discount_due_date: null,
  paid_amount: null,
  currency: "USDC",
};

export const PART_PAID_VIEWS = views;
