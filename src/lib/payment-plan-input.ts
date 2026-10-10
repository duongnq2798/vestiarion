import type { AgentBudgetStatus } from "./agent-budget";
import { invoiceDiscount } from "./agent/payment-timing";
import { cashOutlook } from "./cash-outlook";
import type { WalletHost } from "./config";
import type { PaymentPlanInput, PlanBill, PlanMilestone } from "./payment-plan";

/**
 * The rows a payment plan is built from, turned into the planner's input (payment plan design P3, P11, P12). The
 * Bills & receivables page hands it the rows it read; the command that approves a line reads them again and hands them
 * here too, so both build the same plan, with the same fingerprints. Pure.
 */

export interface PlanRows {
  now: number;
  invoices: ReadonlyArray<{
    id: string;
    direction: string;
    counterparty_id: string;
    counterparty_name: string;
    amount: number;
    currency?: string | null;
    due_date: string;
    status: string;
    scheduled_for: string | null;
    early_pay_discount_pct?: string | number | null;
    discount_due_date?: string | null;
    created_by?: string | null;
  }>;
  counterparties: ReadonlyArray<{ id: string; address: string | null; payment_limit: number | null; risk_level: string }>;
  /** Null when they could not be read. */
  milestones: ReadonlyArray<{ id: string; contractor_id: string; contractor_name: string; title: string; amount: number; status: string; escrow_state?: string | null }> | null;
  accounts: ReadonlyArray<{ kind: string; balance: number | string; circle_wallet_id?: string | null; address?: string | null; balance_synced_at?: string | null }>;
  chainMode: "live" | "simulate";
  walletHost: WalletHost | null;
  /** The agent's spending limit and what it paid against it; `unread` when it could not be read. */
  budget: AgentBudgetStatus | null | "unread";
  twoApprovalsAbove: number | null | "unread";
}

const num = (value: number | string | null | undefined) => (typeof value === "number" ? value : Number(value ?? 0));

export function paymentPlanInput(rows: PlanRows): PaymentPlanInput {
  const unread: string[] = [];
  const counterparties = new Map(rows.counterparties.map((counterparty) => [counterparty.id, counterparty]));
  const payables = rows.invoices.filter((invoice) => invoice.direction === "payable");
  const milestones = rows.milestones ?? [];
  if (rows.budget === "unread") unread.push("the agent's spending limit");
  if (rows.twoApprovalsAbove === "unread") unread.push("the figure for two approvals");
  if (rows.milestones === null) unread.push("the open milestones");

  const operating = rows.accounts.find((account) => account.kind === "operating");
  const operatingUsdc = num(operating?.balance);
  const reserveUsdc = num(rows.accounts.find((account) => account.kind === "reserve")?.balance);
  // The chain's balance when payments are live and the operating account holds a wallet, as the console's balance tile
  // reads it (a workspace paying from its owner's own wallet has the address and no Circle wallet); a sandbox's own
  // figure otherwise.
  const wallet = rows.accounts.find(
    (account) => account.kind === "operating" && (!!account.circle_wallet_id || (rows.walletHost === "external" && !!account.address))
  );

  // Safe to spend's cushion, so the two figures never disagree (P3).
  const { cushion } = cashOutlook({
    now: rows.now,
    operatingUsdc,
    reserveUsdc,
    payables: payables.map((invoice) => ({
      id: invoice.id,
      counterparty: invoice.counterparty_name,
      amount: num(invoice.amount),
      currency: invoice.currency ?? null,
      due_date: invoice.due_date,
      status: invoice.status,
      scheduled_for: invoice.scheduled_for ?? null,
    })),
    milestones: milestones.map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      contractor: milestone.contractor_name,
      amount: num(milestone.amount),
      status: milestone.status,
      escrow_state: milestone.escrow_state ?? null,
    })),
    receivables: [],
  });

  const bills: PlanBill[] = payables.map((invoice) => {
    const counterparty = counterparties.get(invoice.counterparty_id);
    return {
      id: invoice.id,
      counterpartyId: invoice.counterparty_id,
      payee: invoice.counterparty_name,
      payeeAddress: counterparty?.address ?? null,
      amount: num(invoice.amount),
      currency: invoice.currency ?? "USDC",
      dueDate: invoice.due_date,
      status: invoice.status,
      scheduledFor: invoice.scheduled_for ?? null,
      discount: invoiceDiscount(invoice),
      paymentLimit: counterparty?.payment_limit == null ? null : num(counterparty.payment_limit),
      riskLevel: counterparty?.risk_level ?? null,
      createdBy: invoice.created_by ?? null,
    };
  });
  const planMilestones: PlanMilestone[] = milestones.map((milestone) => ({
    id: milestone.id,
    counterpartyId: milestone.contractor_id,
    payee: milestone.contractor_name,
    title: milestone.title,
    amount: num(milestone.amount),
    status: milestone.status,
    escrowState: milestone.escrow_state ?? null,
  }));

  const status = rows.budget === "unread" ? null : rows.budget;
  const figures = status?.budget ?? null;
  const budget =
    status && figures && (figures.dailyUsdc !== null || figures.weeklyUsdc !== null)
      ? { dailyUsdc: figures.dailyUsdc, weeklyUsdc: figures.weeklyUsdc, spentToday: status.spent.today, spentThisWeek: status.spent.week }
      : null;

  return {
    now: rows.now,
    operatingUsdc,
    reserveUsdc,
    cushion,
    bills,
    milestones: planMilestones,
    limits: { budget, twoApprovalsAbove: rows.twoApprovalsAbove === "unread" ? null : rows.twoApprovalsAbove },
    balance: rows.chainMode === "live" && wallet ? { kind: "chain", syncedAt: wallet.balance_synced_at ?? null } : { kind: "simulated" },
    unread,
  };
}
