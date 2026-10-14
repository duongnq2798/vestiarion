import type { CommissionLine, CommissionPayout, CommissionPlan } from "@/lib/commissions/model";
import type { CommissionsData } from "@/lib/commissions/read";

/**
 * Sample commissions for /docs-shots/commissions (docs/superpowers/specs/2026-10-14-commissions-design.md C10): two
 * partners, one paid net on every deal and one paid gross on one deal and named as a member, a version ended, payments
 * applied in full and in part, a commission held in its window, one already paid, and a reversal carried forward.
 */

export const COMMISSIONS_NOW = new Date("2026-10-14T09:00:00.000Z");

const id = (n: number) => `0c0ffee0-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const LENA = id(1);
export const BRIGHTLINE = id(2);
const ACME = id(3);
const HARBOR = id(4);
const WEBSITE = id(11);
const STORE = id(12);
const MEMBER = "docs-sample-admin";

const PLANS: CommissionPlan[] = [
  {
    id: id(21), beneficiaryId: LENA, memberId: null, rateBps: 1000, basis: "net", scope: "all_deals", dealIds: [], holdDays: 30,
    reference: "Referral agreement 2026", startedAt: "2026-08-01T10:00:00.000Z", endedAt: null, replaces: id(20), createdBy: "docs-sample-owner",
  },
  {
    id: id(22), beneficiaryId: BRIGHTLINE, memberId: MEMBER, rateBps: 1250, basis: "gross", scope: "chosen_deals", dealIds: [STORE], holdDays: 14,
    reference: null, startedAt: "2026-09-01T10:00:00.000Z", endedAt: null, replaces: null, createdBy: "docs-sample-owner",
  },
  {
    id: id(20), beneficiaryId: LENA, memberId: null, rateBps: 800, basis: "net", scope: "all_deals", dealIds: [], holdDays: 30,
    reference: null, startedAt: "2026-06-01T10:00:00.000Z", endedAt: "2026-08-01T10:00:00.000Z", replaces: null, createdBy: "docs-sample-owner",
  },
];

function line(n: number, over: Partial<CommissionLine>): CommissionLine {
  return {
    id: id(100 + n), kind: "accrual", planId: id(21), beneficiaryId: LENA, invoiceId: id(31), dealId: WEBSITE, source: "payment",
    allocationId: id(200 + n), transferId: id(300 + n), adjusts: null, basis: "net", base: 0, rateBps: 1000, amount: 0, currency: "USDC",
    appliedAt: "2026-09-01T10:00:00.000Z", dueAt: "2026-10-01T10:00:00.000Z", reason: null, payoutId: null, ...over,
  };
}

const PAID_PAYOUT = id(41);

const LINES: CommissionLine[] = [
  // Paid already, then the payment it was on reversed: carried forward.
  line(1, { invoiceId: id(30), base: 4_000_000_000, amount: 400_000_000, appliedAt: "2026-08-10T10:00:00.000Z", dueAt: "2026-09-09T10:00:00.000Z", payoutId: PAID_PAYOUT }),
  line(2, {
    kind: "adjustment", invoiceId: id(30), base: 4_000_000_000, amount: -400_000_000, adjusts: id(101), allocationId: id(250), reason: "allocation_reversed",
    appliedAt: "2026-10-09T15:00:00.000Z", dueAt: "2026-10-09T15:00:00.000Z",
  }),
  // A deposit paid in full, past its window.
  line(3, { invoiceId: id(31), base: 3_000_000_000, amount: 300_000_000, appliedAt: "2026-09-01T10:00:00.000Z", dueAt: "2026-10-01T10:00:00.000Z" }),
  // A part payment of the balance, past its window.
  line(4, { invoiceId: id(32), base: 2_500_000_000, amount: 250_000_000, appliedAt: "2026-09-10T10:00:00.000Z", dueAt: "2026-10-10T10:00:00.000Z" }),
  // The rest of it, still held.
  line(5, { invoiceId: id(32), base: 1_500_000_000, amount: 150_000_000, appliedAt: "2026-09-28T10:00:00.000Z", dueAt: "2026-10-28T10:00:00.000Z" }),
  // Brightline, gross: a payment and the difference recorded as a fee beside it.
  line(6, {
    planId: id(22), beneficiaryId: BRIGHTLINE, invoiceId: id(33), dealId: STORE, basis: "gross", rateBps: 1250, base: 1_999_500_000, amount: 249_937_500,
    appliedAt: "2026-09-20T10:00:00.000Z", dueAt: "2026-10-04T10:00:00.000Z",
  }),
  line(7, {
    planId: id(22), beneficiaryId: BRIGHTLINE, invoiceId: id(33), dealId: STORE, source: "fee", transferId: null, basis: "gross", rateBps: 1250, base: 500_000,
    amount: 62_500, appliedAt: "2026-09-20T10:05:00.000Z", dueAt: "2026-10-04T10:05:00.000Z",
  }),
];

const PAYOUTS: CommissionPayout[] = [
  { id: PAID_PAYOUT, beneficiaryId: LENA, invoiceId: id(51), statement: "CS-7F3A21C9", currency: "USDC", amount: 400_000_000, lineCount: 1, createdBy: "docs-sample-owner", createdAt: "2026-09-12T09:00:00.000Z", invoiceStatus: "paid" },
];

export const COMMISSIONS: CommissionsData = {
  available: true,
  plans: PLANS,
  lines: LINES,
  payouts: PAYOUTS,
  counterparties: [
    { id: ACME, name: "Acme Corp", role: "client" },
    { id: BRIGHTLINE, name: "Brightline Partners", role: "contractor" },
    { id: HARBOR, name: "Harbor Foods", role: "client" },
    { id: LENA, name: "Lena Ortiz Referrals", role: "vendor" },
    { id: id(5), name: "Northwind Hosting", role: "vendor" },
  ],
  deals: [
    { id: WEBSITE, title: "Website rebuild", customer: "Acme Corp", status: "active" },
    { id: STORE, title: "Store launch", customer: "Harbor Foods", status: "active" },
  ],
  receivables: new Map([
    [id(30), { id: id(30), label: "INV-1038 Discovery sprint", amount: 4_000_000_000, currency: "USDC", customer: "Acme Corp" }],
    [id(31), { id: id(31), label: "INV-1042 Website rebuild: deposit", amount: 3_000_000_000, currency: "USDC", customer: "Acme Corp" }],
    [id(32), { id: id(32), label: "INV-1043 Website rebuild: balance", amount: 7_000_000_000, currency: "USDC", customer: "Acme Corp" }],
    [id(33), { id: id(33), label: "INV-2001 Store launch", amount: 2_000_000_000, currency: "USDC", customer: "Harbor Foods" }],
  ]),
};

export const COMMISSION_MEMBERS = [
  { userId: "docs-sample-owner", email: "olivia@northstar.example", role: "owner" },
  { userId: MEMBER, email: "adam@northstar.example", role: "admin" },
];
