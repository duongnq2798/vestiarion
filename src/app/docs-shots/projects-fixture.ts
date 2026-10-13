import { PROJECT_BUDGET_RULE } from "@/lib/agent/obligation-checks";
import type { WaitingPayable } from "@/lib/agent/approvals";
import type { LedgerEntry } from "@/lib/ledger";
import type { PlanLine } from "@/lib/payment-plan";
import { projectFigures, type ProjectWork } from "@/lib/projects/model";
import type { ProjectDeal, ProjectSummary } from "@/lib/projects/read";
import { SAME_WORK_RULE } from "@/lib/projects/same-work";
import { homeChain } from "@/lib/payee-chains";
import type { CounterpartyRow, InvoiceRow } from "@/lib/queries";
import { explainPayable, presentReasoning } from "@/lib/reasoning-copy";

/**
 * Projects with sample data, for the partner's review of docs/superpowers/specs/2026-10-13-project-budgets-design.md
 * (`docs/superpowers/specs/project-budgets-shots/`): three projects on Tuesday, Oct 13, 2026, one with a bill held for its
 * budget, one on track, one a person paid past its budget; the first project's page; the held bill in Approvals and on
 * its card; and a bill held as the same work as a milestone. Made up: no workspace has these projects.
 */

export const PROJECTS_TODAY = "2026-10-13";
export const PROJECTS_CASH = 14_250;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const WEBSITE_ID = uuid(9101);

const summary = (
  n: number,
  name: string,
  budgetMinor: number,
  bufferMinor: number,
  money: Parameters<typeof projectFigures>[1],
  holds: { now: number; last30Days: number },
  revenue: ProjectSummary["revenue"],
  status: "active" | "archived" = "active"
): ProjectSummary => {
  const project = { id: n === 1 ? WEBSITE_ID : uuid(9100 + n), name, budgetMinor, bufferMinor, status, createdAt: "2026-09-21T09:00:00Z" };
  return { project, figures: projectFigures(project, money, holds), revenue };
};

/** Website rebuild: 1,450.00 USDC left after its buffer, and the 1,750.00 USDC launch video held for its budget. */
export const WEBSITE = summary(
  1,
  "Website rebuild for Acme",
  1_200_000,
  50_000,
  { reservedMinor: 620_000, paidMinor: 385_000, openMinor: 795_000, openCount: 4, unreservedMinor: 175_000, unreservedCount: 1 },
  { now: 1, last30Days: 2 },
  { deals: 1, usdcMinor: 900_000, other: [] }
);

export const PROJECTS: ProjectSummary[] = [
  WEBSITE,
  summary(2, "Spring launch", 400_000, 0, { reservedMinor: 120_000, paidMinor: 90_000, openMinor: 120_000, openCount: 1, unreservedMinor: 0, unreservedCount: 0 }, { now: 0, last30Days: 0 }, { deals: 0, usdcMinor: 0, other: [] }),
  summary(3, "Office move", 250_000, 0, { reservedMinor: 0, paidMinor: 264_000, openMinor: 0, openCount: 0, unreservedMinor: 0, unreservedCount: 0 }, { now: 0, last30Days: 1 }, { deals: 0, usdcMinor: 0, other: [] }),
];

export const SET_ASIDE_ALL = PROJECTS.reduce((sum, entry) => sum + entry.figures.reservedMinor, 0);

const work = (n: number, kind: "bill" | "milestone", label: string, counterpartyName: string, amountMinor: number, status: string, state: ProjectWork["state"], over: Partial<ProjectWork> = {}): ProjectWork => ({
  kind,
  id: uuid(9200 + n),
  label,
  counterpartyName,
  amountMinor,
  status,
  state,
  heldForBudget: false,
  heldAsSameWork: false,
  dueOn: null,
  ...over,
});

export const HELD_VIDEO_ID = uuid(9204);

export const WEBSITE_WORK: ProjectWork[] = [
  work(1, "bill", "INV-2041 · Homepage design", "Northwind Studio", 240_000, "scheduled", "reserved", { dueOn: "2026-10-16" }),
  work(2, "milestone", "Content migration", "Lina Park", 180_000, "verified", "reserved"),
  work(3, "bill", "KP-102 · Launch print run", "Kestrel Print", 200_000, "pending", "reserved", { dueOn: "2026-10-22" }),
  { ...work(4, "bill", "BM-2290 · Launch video", "Brightline Media", 175_000, "held", "not_reserved", { dueOn: "2026-10-20", heldForBudget: true }), id: HELD_VIDEO_ID },
  work(5, "bill", "CC-77 · Staging servers", "Cobalt Cloud", 85_000, "paid", "paid", { dueOn: "2026-10-02" }),
  work(6, "milestone", "Discovery and wireframes", "Lina Park", 300_000, "paid", "paid"),
];

export const WEBSITE_DEALS: ProjectDeal[] = [
  { id: uuid(9301), title: "Acme website rebuild", customer: "Acme Retail", currency: "USDC", digits: 2, totalMinor: 1_800_000, collectedMinor: 900_000 },
];

const line = (n: number, over: Partial<PlanLine> & Pick<PlanLine, "kind" | "payee" | "amount" | "state" | "on" | "reason">): PlanLine => ({
  id: uuid(9200 + n),
  counterpartyId: uuid(9400 + n),
  title: null,
  status: "pending",
  dueOn: over.on,
  agentOn: null,
  inWindow: over.on !== null,
  pays: over.amount,
  discount: null,
  flags: [],
  balanceAfter: null,
  agentPays: true,
  move: null,
  approvable: false,
  createdBy: null,
  fingerprint: `fixture-${n}`,
  ...over,
});

/** The project's lines of the whole treasury's 14-day plan. */
export const WEBSITE_PLAN: PlanLine[] = [
  line(2, { kind: "milestone", payee: "Lina Park", title: "Content migration", amount: 1800, state: "on_its_way", on: "2026-10-13", reason: "Verified: the agent releases it today.", balanceAfter: 12_450 }),
  line(1, { kind: "bill", payee: "Northwind Studio", amount: 2400, status: "scheduled", state: "planned", on: "2026-10-16", agentOn: "2026-10-16", reason: "On the day the agent scheduled it, its due day.", balanceAfter: 9_550 }),
  line(4, {
    kind: "bill",
    payee: "Brightline Media",
    amount: 1750,
    status: "held",
    state: "waiting",
    on: "2026-10-20",
    reason: "Held for a person: its project's budget has no room left for it.",
    agentPays: false,
  }),
  line(3, { kind: "bill", payee: "Kestrel Print", amount: 2000, state: "planned", on: "2026-10-22", reason: "On its due day: nothing is gained by paying sooner.", balanceAfter: 5_800 }),
];

export const WEBSITE_DUE_14_DAYS = WEBSITE_PLAN.filter((entry) => entry.inWindow && (entry.state === "planned" || entry.state === "on_its_way")).reduce((sum, entry) => sum + Math.round(entry.pays * 100), 0);

// ------------------------------------------------------------------ a held bill, in Approvals and on its card

const counterparty = (n: number, name: string, role = "vendor"): CounterpartyRow => ({
  id: uuid(9400 + n),
  name,
  role,
  address: `0x${"5eed".repeat(10)}`,
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
});

export const BRIGHTLINE = counterparty(4, "Brightline Media");
export const LINA = counterparty(7, "Lina Park", "contractor");

const MODEL_REASONING = (name: string, amount: string, po: string) =>
  `Purchase order ${po} matches and the work was received. ${name} is screened clear, and ${amount} USDC is within its 5,000.00 USDC limit. It is due Oct 20, 2026, so I would pay it now.`;

const BUDGET_NOTE =
  ' [guardrail override: project "Website rebuild for Acme" has 1,450.00 USDC of its 12,000.00 USDC budget left to set aside after its 500.00 USDC buffer, less than the 1,750.00 USDC this needs — payment refused before execution; a person pays it in Approvals, moves it, or raises the project\'s budget]';

const SAME_WORK_EXPLANATION =
  'This bill names purchase order PO-2210, as the milestone "Content migration" for the same payee does (verified): paying both would pay that order twice.';
const SAME_WORK_NOTE = ` [guardrail override: this${SAME_WORK_EXPLANATION.slice(4, -1)} — payment refused before execution; a person pays it in Approvals if both are owed]`;

const invoice = (n: number, party: CounterpartyRow, over: Partial<InvoiceRow> & Pick<InvoiceRow, "amount" | "memo" | "po_reference" | "agent_reasoning">): InvoiceRow => ({
  id: n === 4 ? HELD_VIDEO_ID : uuid(9200 + n),
  direction: "payable",
  counterparty_id: party.id,
  counterparty_name: party.name,
  goods_received: true,
  due_date: "2026-10-20T00:00:00Z",
  status: "held",
  tx_ref: null,
  scheduled_for: null,
  early_pay_discount_pct: null,
  discount_due_date: null,
  paid_amount: null,
  currency: "USDC",
  created_by: "docs-sample-admin",
  ...over,
});

export const HELD_VIDEO = invoice(4, BRIGHTLINE, {
  amount: 1750,
  memo: "BM-2290 · Launch video",
  po_reference: "PO-2290",
  agent_reasoning: MODEL_REASONING("Brightline Media", "1,750.00", "PO-2290") + BUDGET_NOTE,
});

export const SAME_WORK_BILL = invoice(8, LINA, {
  amount: 1800,
  memo: "Invoice 14 · Content migration",
  po_reference: "PO-2210",
  due_date: "2026-10-23T00:00:00Z",
  agent_reasoning: MODEL_REASONING("Lina Park", "1,800.00", "PO-2210").replace("It is due Oct 20, 2026", "It is due Oct 23, 2026") + SAME_WORK_NOTE,
});

const entry = (seq: number, row: InvoiceRow, detail: Record<string, unknown>): LedgerEntry =>
  ({
    seq,
    id: `entry-${seq}`,
    ts: "2026-10-13T08:30:00Z",
    actor: "agent",
    domain: "ap",
    action: "ap_pay",
    summary: `PAY invoice from ${row.counterparty_name} for ${row.amount} USDC`,
    detail: {
      invoiceId: row.id,
      counterpartyId: row.counterparty_id,
      decisionMode: "llm",
      decision: { action: "pay", reasoning: (row.agent_reasoning ?? "").replace(/ \[guardrail override:.*\]$/, "") },
      guardrailBlocked: true,
      currency: "USDC",
      execution: { resultingStatus: "held", chainMode: "live", txRef: null },
      ...detail,
    },
    prevHash: "0".repeat(64),
    hash: String(seq).padStart(64, "a"),
    bodyHash: String(seq).padStart(64, "b"),
    signature: null,
    signingKeyId: null,
  }) as unknown as LedgerEntry;

const OBSERVED = { riskLevel: "clear", paymentLimit: 5000, goodsReceived: true, purchaseOrderRequired: true, operatingBalance: PROJECTS_CASH };

export const HELD_VIDEO_ENTRY = entry(6120, HELD_VIDEO, {
  guardrailRule: PROJECT_BUDGET_RULE,
  execution: { resultingStatus: "held", chainMode: "live", txRef: null, heldBecause: "project_budget" },
  observed: {
    ...OBSERVED,
    amount: 1750,
    poReference: "PO-2290",
    projectId: WEBSITE_ID,
    project: { id: WEBSITE_ID, name: "Website rebuild for Acme", state: "over", neededMinor: 175_000, budgetMinor: 1_200_000, bufferMinor: 50_000, reservedMinor: 620_000, paidMinor: 385_000, availableMinor: 145_000 },
    duplicateCheck: { candidatesConsidered: 14, matchesTotal: 0, matchesShown: 0, matches: [] },
  },
});

export const SAME_WORK_ENTRY = entry(6121, SAME_WORK_BILL, {
  guardrailRule: SAME_WORK_RULE,
  observed: {
    ...OBSERVED,
    amount: 1800,
    poReference: "PO-2210",
    sameWork: [{ otherKind: "milestone", otherId: uuid(9202), otherStatus: "verified", signal: "purchase_order", reference: "PO-2210", finding: SAME_WORK_EXPLANATION }],
    duplicateCheck: { candidatesConsidered: 14, matchesTotal: 0, matchesShown: 0, matches: [] },
  },
});

/** The held bills as Approvals lists them, their explanation read from the reasoning as the page reads it. */
function waiting(row: InvoiceRow, party: CounterpartyRow, decision: LedgerEntry, rule: string): WaitingPayable {
  return {
    id: row.id,
    counterpartyId: party.id,
    counterpartyName: party.name,
    riskLevel: "clear",
    amount: row.amount,
    dueDate: row.due_date,
    status: "held",
    reasoning: row.agent_reasoning,
    explanation: presentReasoning(
      row.agent_reasoning,
      explainPayable({ name: party.name, amount: row.amount, currency: "USDC", dueDate: row.due_date, poReference: row.po_reference, goodsReceived: true, entry: { ts: decision.ts, detail: decision.detail } })
    ),
    decidedAt: "2026-10-13T08:30:00Z",
    createdBy: "docs-sample-admin",
    reviewedAt: null,
    reclaimable: false,
    paymentSent: false,
    address: party.address,
    lastAttempt: null,
    discount: null,
    currency: "USDC",
    payeeChain: homeChain("arc-testnet").id,
    bridgeFeeUsdc: null,
    poReference: row.po_reference,
    goodsReceived: true,
    addedSinceDecision: null,
    guardrailRule: rule,
  };
}

export const HELD_VIDEO_WAITING = waiting(HELD_VIDEO, BRIGHTLINE, HELD_VIDEO_ENTRY, PROJECT_BUDGET_RULE);
export const SAME_WORK_WAITING = waiting(SAME_WORK_BILL, LINA, SAME_WORK_ENTRY, SAME_WORK_RULE);
