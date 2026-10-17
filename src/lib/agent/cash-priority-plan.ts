import { z } from "zod";
import { bankAccountsOf } from "../bank-payouts/store";
import { unwrap, type OrgDb } from "../dal";
import { appendLedgerEntry } from "../ledger";
import { heldForCash } from "../next-step";
import { REASONING_RULE, REASONING_SHAPE } from "../reasoning-copy";
import { boundOrder, competingBills, needsPlan, planFingerprint, planFrom, planOf, referenceOrder, sameSplit, PRIORITY_HORIZON_DAYS, type Competing, type PriorityPlan, type PriorityRow } from "./cash-priority";
import { decide } from "./decide";
import type { CycleLogLine } from "./orchestrator";

/**
 * The plan for which bills the cash goes to first (docs/superpowers/specs/2026-10-18-cash-priority-design.md P1-P5), made
 * at the start of the AP stage: read the open bills, set aside the cash already committed, and when the competing bills
 * add up to more than what is left, reuse the last signed plan if nothing changed, or ask the model for the order (the
 * written policy's is its reference), bound it, sign it, and reopen the kept bills held for want of cash.
 */

export const CASH_PRIORITY_SET = "cash_priority_set";

/** Every AP decision action, and a person's move from the payment plan: a bill's latest word is the first of these. */
const DECISION_ACTIONS = ["ap_pay", "ap_hold", "ap_schedule", "ap_request_info", "ap_flag_fraud", "payment_rescheduled"];

const DAY_MS = 86_400_000;
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export const PRIORITY_SYSTEM_PROMPT = `You are the cash step of a treasury agent for a small business. The cash it can pay with cannot cover every bill below, all due within ${PRIORITY_HORIZON_DAYS} days or overdue. Decide the order they are paid in: code pays them in your order while the cash lasts, and the rest wait. A bill that waits is held for a person, the agent asks its supplier for more time and customers to pay sooner, and it is decided again once cash comes in.

- Put first what costs the business most to pay late: a recurring service it runs on (hosting, storage, software, rent) can be stopped; an early-payment discount is lost after its day; a supplier who already declined more time will not wait again; a bill already overdue hurts more each day.
- Put later what can wait: a one-off purchase, a supplier who agreed to more time before, a bill due later.
- Paying two small bills can keep two suppliers whole where one large bill keeps one.
- The written policy's order, given as a reference, pays the bill due first, the smaller first on the same day. Follow it unless the facts say otherwise, and say why when you depart from it.
- Name every bill once, by its ref. Give each a reason of one sentence.
- ${REASONING_RULE}

Respond with ONLY a single JSON object in the requested shape. No prose outside the JSON.`;

const orderSchema = z.object({
  order: z.array(z.string()).min(1),
  reasons: z.record(z.string(), z.string().max(400)).optional(),
  reasoning: z.string().min(1).max(2000),
});
type OrderDecision = z.infer<typeof orderSchema>;

interface OpenRow {
  id: string;
  status: string;
  amount: string | number;
  currency: string | null;
  due_date: string;
  memo: string | null;
  po_reference: string | null;
  recurring_id: string | null;
  early_pay_discount_pct: string | number | null;
  discount_due_date: string | null;
  counterparty_id: string;
  counterparties: { name: string } | null;
  recurring_payables: { every_count: number; every_unit: string } | null;
}

export interface CashPriority {
  plan: PriorityPlan;
  /** What the kept bills add up to: what a waiting bill's hold needs besides its own amount (review of the plan). */
  keptTotal: number;
  /** Whether this cycle asked for it, rather than reusing the last one. */
  fresh: boolean;
  lines: CycleLogLine[];
}

const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
const num = (value: unknown) => Number(value ?? 0);

/** The written policy's reason for a bill's place (P2). */
function referenceReason(bill: Competing, today: string): string {
  return bill.dueOn < today ? `Overdue since ${bill.dueOn}: paid first.` : bill.dueOn === today ? "Due today." : `Due ${bill.dueOn}.`;
}

/**
 * The plan for this cycle, or null when there is no choice to make (the cash covers every competing bill), in shadow
 * mode, or before anything competes (P1, P7). A read that fails leaves the stage as it was: no plan.
 */
export async function cashPriority(input: { db: OrgDb; now: Date; operatingBalance: number; reserveBalance: number; shadow: boolean }): Promise<CashPriority | null> {
  if (input.shadow) return null;
  const { db, now } = input;
  const today = utcDay(now.getTime());
  const rows = unwrap(
    await db
      .from("invoices")
      .select("id, status, amount, currency, due_date, memo, po_reference, recurring_id, early_pay_discount_pct, discount_due_date, counterparty_id, counterparties(name), recurring_payables(every_count, every_unit)")
      .eq("direction", "payable")
      .in("status", ["pending", "matched", "scheduled", "held"])
  ) as unknown as OpenRow[];
  if (rows.length === 0) return null;

  // The latest word on each held or scheduled bill: every AP decision, an `ap_schedule` a guardrail held included, and
  // a person's move from the payment plan (review of the plan).
  const decidedRows = rows.filter((row) => row.status === "held" || row.status === "scheduled");
  const [decisions, bankPaid, milestonesRead] = await Promise.all([
    decidedRows.length > 0
      ? db.from("ledger_entries").select("action, detail").in("action", DECISION_ACTIONS).in("detail->>invoiceId", decidedRows.map((row) => row.id)).order("seq", { ascending: false }).limit(1000)
      : Promise.resolve({ data: [], error: null }),
    bankAccountsOf([...new Set(rows.map((row) => row.counterparty_id))], db),
    db.from("milestones").select("amount, escrow_state").eq("status", "verified").eq("verified", true),
  ]);
  const latest = new Map<string, Record<string, unknown>>();
  const latestAction = new Map<string, string>();
  for (const entry of (unwrap(decisions) as Array<{ action: string; detail: Record<string, unknown> }>)) {
    const id = typeof entry.detail.invoiceId === "string" ? entry.detail.invoiceId : null;
    if (id && !latest.has(id)) {
      latest.set(id, entry.detail);
      latestAction.set(id, entry.action);
    }
  }
  // A scheduled bill a person moved from the payment plan keeps its day: its cash is committed, not weighed (review).
  const personMoved = new Set(rows.filter((row) => row.status === "scheduled" && latestAction.get(row.id) === "payment_rescheduled").map((row) => row.id));

  // Committed first (P1): payments in flight, verified milestones, which are released today, and those person-moved bills.
  const inFlight = rows.filter((row) => row.status === "matched" && (row.currency ?? "USDC") === "USDC").reduce((sum, row) => sum + num(row.amount), 0);
  const moved = rows.filter((row) => personMoved.has(row.id) && (row.currency ?? "USDC") === "USDC").reduce((sum, row) => sum + num(row.amount), 0);
  const verified = (unwrap(milestonesRead) as Array<{ amount: string | number; escrow_state?: string | null }>).filter((row) => row.escrow_state !== "funded").reduce((sum, row) => sum + num(row.amount), 0);
  const committed = Number((inFlight + verified + moved).toFixed(6));
  const available = Number((input.operatingBalance + input.reserveBalance - committed).toFixed(6));

  const priorityRows: PriorityRow[] = rows.filter((row) => !personMoved.has(row.id)).map((row) => ({
    id: row.id,
    status: row.status,
    amount: num(row.amount),
    currency: row.currency === "EURC" ? "EURC" : "USDC",
    dueDate: row.due_date,
    heldForCash: row.status === "held" && heldForCash(latest.get(row.id)),
    paidToBank: bankPaid.has(row.counterparty_id),
  }));
  const competing = competingBills(priorityRows, today);
  if (competing.length < 2 || !needsPlan(competing, Math.max(0, available))) return null;

  const fingerprint = planFingerprint(competing);
  const lastRead = await db.from("ledger_entries").select("detail").eq("action", CASH_PRIORITY_SET).order("seq", { ascending: false }).limit(1);
  const last = planOf(((unwrap(lastRead) as Array<{ detail: Record<string, unknown> }>)[0])?.detail);
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const keptTotalOf = (plan: PriorityPlan) => Number(plan.keep.reduce((sum, id) => sum + (competing.find((bill) => bill.id === id)?.amount ?? 0), 0).toFixed(6));
  // The same bills, split the same way by the cash there is now: the last plan stands, with no model call (P5).
  if (last && last.fingerprint === fingerprint && sameSplit(last, competing, Math.max(0, available))) {
    return { plan: last, keptTotal: keptTotalOf(last), fresh: false, lines: await reopenKept(db, last, byId, latest) };
  }

  // Ask the model for the order (P2), each bill by a short ref, with the written policy's order as its reference.
  const reference = referenceOrder(competing);
  const refOf = new Map<string, string>(reference.map((id, index) => [id, `B${index + 1}`]));
  const idOf = new Map<string, string>(reference.map((id, index) => [`B${index + 1}`, id]));
  const competingById = new Map(competing.map((bill) => [bill.id, bill] as const));
  const history = await supplierHistory(db, [...new Set(competing.map((bill) => byId.get(bill.id)?.counterparty_id ?? ""))].filter(Boolean));
  const bills = reference.map((id) => {
    const row = byId.get(id) as OpenRow;
    const bill = competingById.get(id) as Competing;
    const pct = row.early_pay_discount_pct == null ? null : num(row.early_pay_discount_pct);
    return {
      ref: refOf.get(id),
      payee: row.counterparties?.name ?? "a supplier",
      amount: bill.amount,
      currency: "USDC",
      dueOn: bill.dueOn,
      daysUntilDue: Math.round((Date.parse(`${bill.dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS),
      recurring: row.recurring_id ? { every: row.recurring_payables ? `${row.recurring_payables.every_count} ${row.recurring_payables.every_unit}` : "recurring" } : null,
      memo: row.memo,
      purchaseOrder: row.po_reference,
      earlyPayDiscount: pct && row.discount_due_date ? { percent: pct, until: row.discount_due_date.slice(0, 10) } : null,
      status: bill.status === "held" ? "held for want of cash" : bill.status,
      supplierRequestsForMoreTime: history.get(row.counterparty_id) ?? { made: 0, accepted: 0, declined: 0 },
    };
  });
  const policy: OrderDecision = {
    order: reference.map((id) => refOf.get(id) as string),
    reasons: Object.fromEntries(reference.map((id) => [refOf.get(id) as string, referenceReason(competingById.get(id) as Competing, today)])),
    reasoning: "The written policy pays the bill due first, and the smaller first on the same day, while the cash lasts.",
  };
  const decided = await decide<OrderDecision>({
    purpose: "cash_priority",
    systemPrompt: PRIORITY_SYSTEM_PROMPT,
    userPrompt: JSON.stringify({
      task: "Order these bills: the most important to pay first, first.",
      cash: { canPayWith: Math.max(0, available), operating: input.operatingBalance, reserve: input.reserveBalance, alreadyCommitted: committed, billsTotal: Number(competing.reduce((sum, bill) => sum + bill.amount, 0).toFixed(6)) },
      bills,
      writtenPolicy: { order: policy.order },
      responseShape: { order: "every ref once, most important first", reasons: "{ ref: one sentence }", reasoning: REASONING_SHAPE },
    }),
    schema: orderSchema,
    fallback: () => policy,
  });
  const modelOrder = decided.value.order.map((ref) => idOf.get(ref) ?? ref);
  const bounded = boundOrder(modelOrder, reference);
  const { keep, wait } = planFrom(bounded.order, competing, Math.max(0, available));
  const orderIds = bounded.order;
  const reasons: Record<string, string> = {};
  for (const id of bounded.order) {
    const said = decided.value.reasons?.[refOf.get(id) as string];
    reasons[id] = typeof said === "string" && said.trim() ? said.trim() : (policy.reasons?.[refOf.get(id) as string] ?? "");
  }
  const plan: PriorityPlan = { fingerprint, order: orderIds, keep, wait, reasons };
  const sameAsPolicy = bounded.order.every((id, index) => reference[index] === id);
  const keptSet = new Set(keep);
  await appendLedgerEntry({
    actor: "agent",
    domain: "ap",
    action: CASH_PRIORITY_SET,
    summary: `The cash cannot cover every bill due soon: pays ${keep.length} first, ${wait.length} wait`,
    detail: {
      fingerprint,
      cash: { operating: input.operatingBalance, reserve: input.reserveBalance, committed, available },
      order: bounded.order.map((id) => {
        const row = byId.get(id) as OpenRow;
        return { invoiceId: id, payee: row.counterparties?.name ?? null, amount: competingById.get(id)?.amount ?? num(row.amount), dueOn: competingById.get(id)?.dueOn ?? null, keep: keptSet.has(id), reason: reasons[id] };
      }),
      reasoning: decided.value.reasoning,
      decisionMode: decided.mode,
      referenceOrder: reference,
      agreedWithReference: decided.mode === "heuristic" ? null : sameAsPolicy,
      ...(bounded.corrected ? { orderCorrected: true } : {}),
    },
  });
  const named = (ids: string[]) => ids.map((id) => `${byId.get(id)?.counterparties?.name ?? "a supplier"} ${AMOUNT.format(competingById.get(id)?.amount ?? 0)} USDC`).join(", ");
  return {
    plan,
    keptTotal: keptTotalOf(plan),
    fresh: true,
    lines: [{ domain: "ap", message: `cash cannot cover every bill due soon: pays ${named(keep) || "none"} first; ${named(wait)} wait` }, ...(await reopenKept(db, plan, byId, latest))],
  };
}

/**
 * The kept bills held for want of cash, reopened to be decided again this cycle (P4): a compare-and-set on `held`, so a
 * person's decision in between stands, and a signed `invoice_reopened` that says why. One held again under this same
 * plan (its latest decision says it was kept by it) is not reopened again: the plan is reused each cycle while nothing
 * changes, and so would the reopen be, with a decision each time.
 */
async function reopenKept(db: OrgDb, plan: PriorityPlan, byId: ReadonlyMap<string, OpenRow>, latest: ReadonlyMap<string, Record<string, unknown>>): Promise<CycleLogLine[]> {
  const lines: CycleLogLine[] = [];
  for (const id of plan.keep) {
    const row = byId.get(id);
    if (!row || row.status !== "held") continue;
    const triedUnder = (latest.get(id)?.cashPriority as Record<string, unknown> | undefined)?.fingerprint;
    if (triedUnder === plan.fingerprint) continue;
    const changed = unwrap(await db.from("invoices").update({ status: "pending", notified_at: null }).eq("id", id).eq("status", "held").select("id")) as Array<{ id: string }>;
    if (changed.length === 0) continue;
    const amount = num(row.amount);
    await appendLedgerEntry({
      actor: "agent",
      domain: "ap",
      action: "invoice_reopened",
      summary: `Reopened held invoice for ${amount} ${row.currency ?? "USDC"}: the agent chose to pay it first with the cash there is`,
      detail: {
        invoiceId: id,
        followUp: { action: "reopen", reason: "cash_priority", changes: [plan.reasons[id] ? `the agent chose to pay it first: ${plan.reasons[id]}` : "the agent chose to pay it first"] },
        previousStatus: "held",
      },
    });
    lines.push({ domain: "ap", message: `${row.counterparties?.name ?? "a supplier"}: reopened, the agent chose to pay it first (${amount} USDC)` });
  }
  return lines;
}

/** What each supplier did with earlier requests for more time (P2): best effort, none before migration 0128. */
async function supplierHistory(db: OrgDb, counterpartyIds: string[]): Promise<Map<string, { made: number; accepted: number; declined: number }>> {
  const history = new Map<string, { made: number; accepted: number; declined: number }>();
  if (counterpartyIds.length === 0) return history;
  const read = await db.from("payment_term_requests").select("counterparty_id, status, counter_days").in("counterparty_id", counterpartyIds).limit(1000);
  if (read.error) return history;
  for (const row of (read.data ?? []) as Array<{ counterparty_id: string; status: string; counter_days: number | null }>) {
    const entry = history.get(row.counterparty_id) ?? { made: 0, accepted: 0, declined: 0 };
    entry.made += 1;
    if (row.status === "accepted") entry.accepted += 1;
    if (row.status === "declined" && row.counter_days == null) entry.declined += 1;
    history.set(row.counterparty_id, entry);
  }
  return history;
}
