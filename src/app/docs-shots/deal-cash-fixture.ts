import type { WaitingPayable } from "@/lib/agent/approvals";
import { dealCollection, type Collection } from "@/lib/deals/collection";
import type { DealCost } from "@/lib/deals/costs";
import type { LinkCandidate } from "@/lib/deals/costs-read";
import type { DealRecord } from "@/lib/deals/read";
import { NETWORKS } from "@/lib/network";
import { homeChain } from "@/lib/payee-chains";

/**
 * Sample data for the pictures of a deal's cash readiness and of held bills with an owner
 * (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md, `docs/superpowers/specs/deal-cash-shots/`), on
 * Oct 13, 2026: Website rebuild, short by 1,240.00 USDC on Oct 20; Brand refresh, with no gap; a retainer with no cost
 * entered; and three held bills, one past its day, one due today and one due this week.
 */

export const DEAL_CASH_TODAY = "2026-10-13";

type Line = DealRecord["facts"]["lines"][number];

const line = (deal: string, n: number, over: Partial<Line>): Line => ({
  id: `11111111-${deal}-4000-8000-00000000000${n}`,
  position: n,
  kind: "charge",
  label: "",
  invoiceOn: "2026-10-13",
  dueOn: "2026-10-27",
  amountMinor: 0,
  roundingMinor: 0,
  status: "planned",
  addedIn: 1,
  endedIn: null,
  replaces: null,
  releasedAt: null,
  releasedVia: null,
  receivable: null,
  ...over,
});

const deal = (id: string, over: { title: string; customer: string; template: DealRecord["template"]; startsOn: string; lines: Line[]; externalRef?: string }): DealRecord => ({
  facts: {
    id,
    status: "active",
    version: 1,
    totalMinor: over.lines.reduce((sum, each) => sum + each.amountMinor, 0),
    currency: "USDC",
    startsOn: over.startsOn,
    termsDays: 14,
    autoRelease: false,
    lines: over.lines,
  },
  title: over.title,
  customer: { id: `c1c1c1c1-0000-4000-8000-${id.slice(-12)}`, name: over.customer },
  digits: 2,
  externalRef: over.externalRef ?? null,
  template: over.template,
  createdBy: null,
  createdAt: `${over.startsOn}T09:00:00Z`,
  autoReleaseBy: null,
  autoReleaseAt: null,
  versions: [{ version: 1, kind: "signed", totalMinor: over.lines.reduce((sum, each) => sum + each.amountMinor, 0), reason: null, changes: [], createdBy: null, createdAt: `${over.startsOn}T09:00:00Z` }],
});

const SHORT_ID = "dddddddd-0000-4000-8000-00000000c501";
const COVERED_ID = "dddddddd-0000-4000-8000-00000000c502";
const NO_COSTS_ID = "dddddddd-0000-4000-8000-00000000c503";

/** 12,000.00 USDC: a 30% deposit invoiced today, due Oct 27; the balance on Dec 1. A contractor is paid on Oct 20. */
export const SHORT_DEAL = deal(SHORT_ID, {
  title: "Website rebuild",
  customer: "Acme Studio",
  template: "deposit",
  startsOn: "2026-10-05",
  externalRef: "HS-48213",
  lines: [
    line("c501", 1, { label: "Deposit (30%)", invoiceOn: "2026-10-13", dueOn: "2026-10-27", amountMinor: 360_000 }),
    line("c501", 2, { label: "Balance on delivery", invoiceOn: "2026-12-01", dueOn: "2026-12-15", amountMinor: 840_000 }),
  ],
});

/** 6,000.00 USDC: half paid already, the rest on Nov 16; a paid illustrator and printing on Nov 10. */
export const COVERED_DEAL = deal(COVERED_ID, {
  title: "Brand refresh",
  customer: "Granite Labs",
  template: "deposit",
  startsOn: "2026-09-21",
  lines: [
    line("c502", 1, {
      label: "Deposit (50%)",
      invoiceOn: "2026-09-21",
      dueOn: "2026-10-05",
      amountMinor: 300_000,
      status: "released",
      releasedAt: "2026-09-21T09:00:00Z",
      releasedVia: "person",
      receivable: { id: "eeeeeeee-0000-4000-8000-00000000c502", status: "received", dueDate: "2026-10-05T00:00:00Z" },
    }),
    line("c502", 2, { label: "Balance on delivery", invoiceOn: "2026-11-02", dueOn: "2026-11-16", amountMinor: 300_000 }),
  ],
});

/** 6,000.00 USDC over three months, with no cost entered. */
export const NO_COSTS_DEAL = deal(NO_COSTS_ID, {
  title: "Support retainer",
  customer: "Orbit Telecom",
  template: "retainer",
  startsOn: "2026-10-01",
  lines: [
    line("c503", 1, { label: "November 2026", invoiceOn: "2026-11-01", dueOn: "2026-11-15", amountMinor: 200_000 }),
    line("c503", 2, { label: "December 2026", invoiceOn: "2026-12-01", dueOn: "2026-12-15", amountMinor: 200_000 }),
    line("c503", 3, { label: "January 2027", invoiceOn: "2027-01-01", dueOn: "2027-01-15", amountMinor: 200_000 }),
  ],
});

const cost = (n: number, over: Partial<DealCost>): DealCost => ({
  id: `22222222-0000-4000-8000-0000000c500${n}`,
  label: "",
  counterparty: null,
  amountMinor: 0,
  expectedOn: DEAL_CASH_TODAY,
  noDocument: false,
  createdAt: `2026-10-0${n}T09:00:00Z`,
  createdBy: null,
  removedAt: null,
  link: null,
  ...over,
});

const LINA = { id: "c1c1c1c1-0000-4000-8000-0000000c5a01", name: "Lina Park" };
const NORTHWIND = { id: "c1c1c1c1-0000-4000-8000-0000000c5a02", name: "Northwind Hosting" };
const INKWELL = { id: "c1c1c1c1-0000-4000-8000-0000000c5a03", name: "Inkwell Print" };

export const SHORT_COSTS: DealCost[] = [
  cost(1, { label: "Contractor: design", counterparty: LINA, amountMinor: 124_000, expectedOn: "2026-10-20", noDocument: true }),
  cost(2, {
    label: "Hosting setup",
    counterparty: NORTHWIND,
    amountMinor: 100_000,
    expectedOn: "2026-11-01",
    link: { kind: "payable", id: "b1b1b1b1-0000-4000-8000-0000000c5b01", counterpartyName: "Northwind Hosting", memo: "INV-7731", status: "held", dueOn: "2026-11-03", scheduledFor: null, settledOn: null, amountMinor: 150_000, paidMinor: null },
  }),
  cost(3, { label: "Stock photos", amountMinor: 30_000, expectedOn: "2026-11-20" }),
  cost(4, { label: "Extra QA week", amountMinor: 90_000, expectedOn: "2026-11-25", removedAt: "2026-10-09T15:00:00Z" }),
];

export const COVERED_COSTS: DealCost[] = [
  cost(1, {
    label: "Illustrator",
    counterparty: LINA,
    amountMinor: 180_000,
    expectedOn: "2026-10-01",
    link: { kind: "milestone", id: "e1e1e1e1-0000-4000-8000-0000000c5e01", title: "Brand illustrations", contractorName: "Lina Park", status: "paid", settledOn: "2026-10-02", amountMinor: 180_000 },
  }),
  cost(2, { label: "Printing", counterparty: INKWELL, amountMinor: 90_000, expectedOn: "2026-11-10" }),
];

export const PAYEES = [LINA, NORTHWIND, INKWELL];

export const LINK_CANDIDATES: LinkCandidate[] = [
  { kind: "payable", id: "b1b1b1b1-0000-4000-8000-0000000c5b02", counterpartyId: LINA.id, amountMinor: 124_000, name: "Lina Park · 1,240.00 USDC · due Oct 22, 2026 · pending" },
  { kind: "milestone", id: "e1e1e1e1-0000-4000-8000-0000000c5e02", counterpartyId: LINA.id, amountMinor: 124_000, name: "Lina Park: Homepage design · 1,240.00 USDC · pending" },
];

export const DEAL_CASH_COSTS = new Map<string, DealCost[]>([
  [SHORT_ID, SHORT_COSTS],
  [COVERED_ID, COVERED_COSTS],
  [NO_COSTS_ID, []],
]);

/**
 * What a pictured deal collected, as its page reads it (`dealCollection`): each line marked received was paid whole on
 * Arc the day before its due day.
 */
export function dealCashCollected(record: DealRecord): Collection {
  const released = record.facts.lines.flatMap((line) => (line.receivable ? [{ line, receivable: line.receivable }] : []));
  return dealCollection({
    deal: { currency: record.facts.currency, digits: record.digits, status: record.facts.status },
    receivables: released.map(({ line, receivable }) => ({
      id: receivable.id,
      amount: line.amountMinor / 10 ** record.digits,
      currency: record.facts.currency,
      status: receivable.status,
      dueOn: receivable.dueDate.slice(0, 10),
      originalCurrency: null,
      originalAmount: null,
    })),
    payments: released
      .filter(({ receivable }) => receivable.status === "received")
      .map(({ line, receivable }) => ({
        transferId: `transfer-${receivable.id}`,
        invoiceId: receivable.id,
        amount: line.amountMinor / 10 ** record.digits,
        receivedAt: `${receivable.dueDate.slice(0, 10)}T09:00:00Z`,
        txHash: null,
        chain: NETWORKS["arc-testnet"].circleBlockchain,
      })),
    fees: [],
    notInvoicedMinor: record.facts.lines.filter((line) => line.status === "planned" && line.kind === "charge").reduce((sum, line) => sum + line.amountMinor, 0),
    today: DEAL_CASH_TODAY,
  });
}

export const DEAL_CASH_MEMBERS = [
  { userId: "docs-sample-owner", email: "ana@northstar.example", role: "owner" },
  { userId: "docs-sample-admin", email: "cam@northstar.example", role: "admin" },
  { userId: "docs-sample-approver", email: "ben@northstar.example", role: "approver" },
  { userId: "docs-sample-viewer", email: "vic@northstar.example", role: "viewer" },
];

const held = (n: number, over: Partial<WaitingPayable>): WaitingPayable => ({
  id: `00000000-0000-4000-8000-0000000c5f0${n}`,
  counterpartyId: NORTHWIND.id,
  counterpartyName: "Northwind Hosting",
  riskLevel: "clear",
  amount: 1500,
  dueDate: "2026-10-12",
  status: "held",
  reasoning: null,
  explanation: "",
  decidedAt: "2026-10-10T08:04:00Z",
  createdBy: "docs-sample-admin",
  reviewedAt: null,
  reclaimable: false,
  paymentSent: false,
  address: "0x7a3c9e2b41d05f8a6c1e3b9d2f4a8c6e0b5d1f93",
  lastAttempt: null,
  discount: null,
  currency: "USDC",
  payeeChain: homeChain("arc-testnet").id,
  bridgeFeeUsdc: null,
  poReference: "PO-2213",
  goodsReceived: true,
  addedSinceDecision: null,
  guardrailRule: "counterparty.payment_limit",
  ...over,
});

/** Past its day; due today with a discount; due this week and asking for a document. */
export const HELD_BILLS: WaitingPayable[] = [
  held(1, {
    explanation: "Held for a person to approve: 1,500.00 USDC is above Northwind Hosting's payment limit of 1,000.00 USDC.",
  }),
  held(2, {
    counterpartyName: "Inkwell Print",
    counterpartyId: INKWELL.id,
    amount: 900,
    dueDate: "2026-10-20",
    discount: { pct: 2, deadline: "2026-10-13" },
    createdBy: "docs-sample-owner",
    explanation: "Held for a person to approve: Inkwell Print has not been screened yet.",
    guardrailRule: "counterparty.unscreened",
  }),
  held(3, {
    counterpartyName: "Lina Park",
    counterpartyId: LINA.id,
    amount: 1240,
    dueDate: "2026-10-16",
    status: "awaiting_info",
    poReference: null,
    goodsReceived: false,
    explanation: "Asked for more information before paying 1,240.00 USDC to Lina Park: no purchase order is on file and no receipt is recorded.",
    guardrailRule: null,
  }),
];
