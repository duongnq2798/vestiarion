import { AGENT_DECISION_ACTIONS } from "./agent/shadow-hold";
import { invoiceDiscount } from "./agent/payment-timing";
import { unwrap, type OrgDb } from "./dal";
import type { Network } from "./network";
import { readShadowMode } from "./shadow-mode";
import type { ReportBill, ReportDecision, ReportFacts, ReportPayment, ReportPersonAction, ReportVerdict } from "./workspace-report";

/**
 * Reads what the workspace report counts (docs/superpowers/specs/2026-10-09-workspace-report-design.md R2), inside the
 * workspace's organization scope: its payables, the agent's decisions on them and people's approvals from the ledger,
 * the verdicts, and the payables' confirmed live Circle payments. Ledger entries come back with the few fields the
 * report reads, not their whole detail. Every read pages through, so a long-lived workspace is counted whole.
 */

const PAGE = 1000;
const PERSON_ACTIONS = ["approval_paid", "approval_rejected", "approval_returned"] as const;

/** Every row of a read, a page at a time; `read` orders its rows so the pages do not overlap. */
async function allRows<T>(read: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
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
  counterparties: { id: string; name: string; sample: boolean | null; mirror_wallet_id: string | null } | null;
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
};

type PersonRow = { seq: number | string; ts: string; action: ReportPersonAction["action"]; invoice_id: string | null };
type VerdictRow = { entry_seq: number | string; verdict: ReportVerdict["verdict"] };
type PaymentRow = {
  source_id: string;
  amount: number | string;
  token: string | null;
  tx_hash: string | null;
  executed_at: string | null;
  confirmed_at: string | null;
  updated_at: string;
};

export async function readReportFacts(orgDb: OrgDb, network: Network): Promise<ReportFacts> {
  const [invoices, decisions, people, verdicts, payments, first, shadow] = await Promise.all([
    allRows<InvoiceRow>((from, to) =>
      orgDb
        .from("invoices")
        .select(
          "id, created_at, due_date, amount, currency, status, reviewed_by, paid_amount, early_pay_discount_pct, discount_due_date, original_currency, original_amount, counterparties(id, name, sample, mirror_wallet_id)"
        )
        .eq("direction", "payable")
        .order("id", { ascending: true })
        .range(from, to)
    ),
    allRows<DecisionRow>((from, to) =>
      orgDb
        .from("ledger_entries")
        .select(
          "seq, ts, action, invoice_id:detail->>invoiceId, guardrail_blocked:detail->guardrailBlocked, guardrail_rule:detail->>guardrailRule, held_because:detail->execution->>heldBecause, resulting_status:detail->execution->>resultingStatus, shadow:detail->shadow, reasoning:detail->decision->>reasoning"
        )
        .eq("actor", "agent")
        .in("action", [...AGENT_DECISION_ACTIONS])
        .order("seq", { ascending: true })
        .range(from, to)
    ),
    allRows<PersonRow>((from, to) =>
      orgDb
        .from("ledger_entries")
        .select("seq, ts, action, invoice_id:detail->>invoiceId")
        .eq("actor", "human")
        .in("action", [...PERSON_ACTIONS])
        .order("seq", { ascending: true })
        .range(from, to)
    ),
    allRows<VerdictRow>((from, to) => orgDb.from("decision_verdicts").select("entry_seq, verdict").order("entry_seq", { ascending: true }).range(from, to)),
    allRows<PaymentRow>((from, to) =>
      orgDb
        .from("payment_intents")
        .select("source_id, amount, token, tx_hash, executed_at, confirmed_at, updated_at")
        .eq("source_type", "invoice")
        .eq("provider", "circle")
        .eq("provider_mode", "live")
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
    payee: {
      id: row.counterparties?.id ?? "",
      name: row.counterparties?.name ?? "a supplier",
      mirror: Boolean(row.counterparties?.mirror_wallet_id),
      sample: row.counterparties?.sample === true,
    },
  }));

  return {
    network,
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
            },
          ]
        : []
    ),
    personActions: people.flatMap<ReportPersonAction>((row) => (row.invoice_id ? [{ seq: Number(row.seq), ts: row.ts, action: row.action, invoiceId: row.invoice_id }] : [])),
    verdicts: verdicts.map((row) => ({ entrySeq: Number(row.entry_seq), verdict: row.verdict })),
    payments: payments.map<ReportPayment>((row) => ({
      invoiceId: row.source_id,
      amount: Number(row.amount),
      token: row.token ?? "USDC",
      txHash: row.tx_hash,
      at: row.executed_at ?? row.confirmed_at ?? row.updated_at,
    })),
  };
}
