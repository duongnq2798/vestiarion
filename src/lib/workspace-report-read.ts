import { AGENT_DECISION_ACTIONS } from "./agent/shadow-hold";
import { invoiceDiscount } from "./agent/payment-timing";
import { unwrap, type OrgDb } from "./dal";
import type { Network } from "./network";
import { readShadowMode } from "./shadow-mode";
import type { ReportBill, ReportDecision, ReportFacts, ReportPayment, ReportPersonAction, ReportVerdict } from "./workspace-report";

/**
 * Reads what the workspace report counts (docs/superpowers/specs/2026-10-09-workspace-report-design.md R2), inside the
 * workspace's organization scope: its payables, the agent's decisions on them and people's approvals from the ledger,
 * the verdicts with when each was given, and the payables' confirmed payments, live or simulated (a sandbox's). Ledger
 * entries come back with the few fields the report reads, not their whole detail. Every read pages through, so a
 * long-lived workspace is counted whole.
 */

const PAGE = 1000;
const PERSON_ACTIONS = ["approval_paid", "approval_rejected", "approval_returned"] as const;

/**
 * Every row of a read, a page at a time; `read` orders its rows so the pages do not overlap. Earned vendors read theirs
 * with it.
 */
export async function allRows<T>(read: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = unwrap(await read(from, from + PAGE - 1)) as T[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

type InvoiceRow = {
  id: string;
  created_at: string;
  due_date: string | null;
  amount: number | string;
  currency: string | null;
  status: string;
  reviewed_by: string | null;
  paid_amount: number | string | null;
  early_pay_discount_pct: number | string | null;
  discount_due_date: string | null;
  original_currency: string | null;
  original_amount: number | string | null;
  fx_rate: number | string | null;
  fx_source: string | null;
  fx_at: string | null;
  counterparties: {
    id: string;
    name: string;
    sample: boolean | null;
    mirror_wallet_id: string | null;
    role?: string | null;
    risk_level?: string | null;
    payment_limit?: number | string | null;
  } | null;
};

type DecisionRow = {
  seq: number | string;
  ts: string;
  action: string;
  invoice_id: string | null;
  guardrail_blocked: boolean | null;
  guardrail_rule: string | null;
  held_because: string | null;
  resulting_status: string | null;
  shadow: boolean | null;
  reasoning: string | null;
  pay_on: string | null;
  earned?: unknown;
};

type PersonRow = { seq: number | string; ts: string; action: ReportPersonAction["action"]; invoice_id: string | null; recorded?: unknown };
type VerdictRow = { entry_seq: number | string; verdict: ReportVerdict["verdict"]; decided_at?: string | null };
type PaymentRow = {
  source_id: string;
  provider: string;
  provider_mode: string | null;
  amount: number | string;
  token: string | null;
  tx_hash: string | null;
  executed_at: string | null;
  confirmed_at: string | null;
  updated_at: string;
};

/** `now` is when the facts are read: the day an early-payment discount's last day is measured against. */
export async function readReportFacts(orgDb: OrgDb, network: Network, workspace: { sandbox: boolean }, now: Date = new Date()): Promise<ReportFacts> {
  const [invoices, decisions, people, verdicts, payments, first, shadow] = await Promise.all([
    allRows<InvoiceRow>((from, to) =>
      orgDb
        .from("invoices")
        .select(
          "id, created_at, due_date, amount, currency, status, reviewed_by, paid_amount, early_pay_discount_pct, discount_due_date, original_currency, original_amount, fx_rate, fx_source, fx_at, counterparties(id, name, sample, mirror_wallet_id, role, risk_level, payment_limit)"
        )
        .eq("direction", "payable")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    allRows<DecisionRow>((from, to) =>
      orgDb
        .from("ledger_entries")
        .select(
          "seq, ts, action, invoice_id:detail->>invoiceId, guardrail_blocked:detail->guardrailBlocked, guardrail_rule:detail->>guardrailRule, held_because:detail->execution->>heldBecause, resulting_status:detail->execution->>resultingStatus, shadow:detail->shadow, reasoning:detail->decision->>reasoning, pay_on:detail->decision->>payOn, earned:detail->earned"
        )
        .eq("actor", "agent")
        .in("action", [...AGENT_DECISION_ACTIONS])
        .order("seq", { ascending: true })
        .range(from, to)
    ),
    allRows<PersonRow>((from, to) =>
      orgDb
        .from("ledger_entries")
        .select("seq, ts, action, invoice_id:detail->>invoiceId, recorded:detail->recorded")
        .eq("actor", "human")
        .in("action", [...PERSON_ACTIONS])
        .order("seq", { ascending: true })
        .range(from, to)
    ),
    allRows<VerdictRow>((from, to) => orgDb.from("decision_verdicts").select("entry_seq, verdict, decided_at").order("entry_seq", { ascending: true }).range(from, to)),
    allRows<PaymentRow>((from, to) =>
      orgDb
        .from("payment_intents")
        .select("source_id, provider, provider_mode, amount, token, tx_hash, executed_at, confirmed_at, updated_at")
        .eq("source_type", "invoice")
        .eq("status", "confirmed")
        .order("source_id", { ascending: true })
        .range(from, to)
    ),
    // The workspace opened with its first ledger entry (`org_created`).
    orgDb.from("ledger_entries").select("ts").order("seq", { ascending: true }).limit(1),
    readShadowMode(orgDb),
  ]);

  const bills: ReportBill[] = invoices.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    dueDate: row.due_date,
    amount: Number(row.amount),
    currency: row.currency ?? "USDC",
    status: row.status,
    reviewedBy: row.reviewed_by,
    paidAmount: row.paid_amount == null ? null : Number(row.paid_amount),
    discount: invoiceDiscount(row),
    bill: row.original_currency && row.original_amount != null ? { amount: Number(row.original_amount), currency: row.original_currency } : null,
    conversion: row.original_currency && row.fx_rate != null && row.fx_source && row.fx_at ? { perUsd: row.fx_rate, source: row.fx_source, at: row.fx_at } : null,
    payee: {
      id: row.counterparties?.id ?? "",
      name: row.counterparties?.name ?? "a supplier",
      mirror: Boolean(row.counterparties?.mirror_wallet_id),
      sample: row.counterparties?.sample === true,
      // Who can earn the owner's rule (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL13).
      ...(row.counterparties?.role ? { role: row.counterparties.role } : {}),
      ...(row.counterparties?.risk_level ? { riskLevel: row.counterparties.risk_level } : {}),
      ...(row.counterparties && "payment_limit" in row.counterparties
        ? { paymentLimit: row.counterparties.payment_limit == null ? null : Number(row.counterparties.payment_limit) }
        : {}),
    },
  }));

  return {
    network,
    sandbox: workspace.sandbox,
    now: now.toISOString(),
    openedAt: (unwrap(first) as Array<{ ts: string }>)[0]?.ts ?? null,
    shadow: shadow ? { currency: shadow.currency, startedAt: shadow.startedAt } : null,
    bills,
    decisions: decisions.flatMap<ReportDecision>((row) =>
      row.invoice_id
        ? [
            {
              seq: Number(row.seq),
              ts: row.ts,
              action: row.action,
              invoiceId: row.invoice_id,
              guardrailBlocked: row.guardrail_blocked === true,
              guardrailRule: row.guardrail_rule,
              heldBecause: row.held_because,
              resultingStatus: row.resulting_status,
              shadow: row.shadow === true,
              reasoning: row.reasoning,
              payOn: row.pay_on,
              // Carried out on its own for an earned vendor (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL27).
              ...(row.earned != null ? { onItsOwn: true } : {}),
            },
          ]
        : []
    ),
    personActions: people.flatMap<ReportPersonAction>((row) =>
      row.invoice_id
        ? [
            {
              seq: Number(row.seq),
              ts: row.ts,
              action: row.action,
              invoiceId: row.invoice_id,
              // Only recorded the transfer sent before it (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL29).
              ...(row.recorded === true ? { recorded: true } : {}),
            },
          ]
        : []
    ),
    verdicts: verdicts.map((row) => ({ entrySeq: Number(row.entry_seq), verdict: row.verdict, ...(row.decided_at ? { decidedAt: row.decided_at } : {}) })),
    payments: payments.map<ReportPayment>((row) => ({
      invoiceId: row.source_id,
      amount: Number(row.amount),
      token: row.token ?? "USDC",
      txHash: row.tx_hash,
      at: row.executed_at ?? row.confirmed_at ?? row.updated_at,
      // Only a live Circle transfer moved anything on chain (0049 counts the same ones).
      simulated: !(row.provider === "circle" && row.provider_mode === "live"),
    })),
  };
}
