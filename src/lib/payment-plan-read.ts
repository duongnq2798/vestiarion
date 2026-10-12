import { agentBudgetStatus } from "./agent-budget";
import { readTwoApprovalsAbove } from "./approval-policy";
import { chainModes } from "./circle";
import { currentOrgConfig } from "./context";
import { db } from "./dal";
import { planPayments, type PaymentPlan, type PaymentPlanInput } from "./payment-plan";
import { paymentPlanInput, type PlanRows } from "./payment-plan-input";
import { listAccounts, listCounterparties, listInvoices, listMilestones, type CounterpartyRow, type InvoiceRow } from "./queries";

type ReadOptions = {
  now?: number;
  invoices?: InvoiceRow[];
  counterparties?: CounterpartyRow[];
  /** The deal lines not invoiced yet the page read, listed apart (deal schedule D14); null when they could not be read. */
  planned?: PlanRows["planned"];
};

/**
 * The payment plan as the workspace in scope stands now (docs/superpowers/specs/2026-10-11-payment-plan-design.md):
 * read for Bills & receivables, which passes the invoices and counterparties it already loaded.
 */
export async function readPaymentPlan(options: ReadOptions = {}): Promise<PaymentPlan> {
  return planPayments(await readPaymentPlanInput(options));
}

/**
 * The rows the plan is built from, as the workspace in scope stands now: read again by the command that approves a
 * line, which builds the plan from them, so a stale plan is refused (P11), and weighs each move it makes against them
 * (`moveObjection`). The limits and the milestones are best effort: one that cannot be read is named on the plan, and
 * approving waits for it (P12). The accounts are not: without the cash there is no plan, and the read throws.
 */
export async function readPaymentPlanInput(options: ReadOptions = {}): Promise<PaymentPlanInput> {
  const now = options.now ?? Date.now();
  const unread = (what: string) => (error: unknown) => {
    console.error(`payment plan: ${what} not read`, error instanceof Error ? error.message : error);
    return "unread" as const;
  };
  const [invoices, counterparties, milestones, accounts, budget, twoApprovalsAbove] = await Promise.all([
    options.invoices ?? listInvoices(),
    options.counterparties ?? listCounterparties(),
    listMilestones().catch((error: unknown) => {
      console.error("payment plan: milestones not read", error instanceof Error ? error.message : error);
      return null;
    }),
    listAccounts(),
    agentBudgetStatus(new Date(now)).catch(unread("spending limit")),
    readTwoApprovalsAbove(db()).catch(unread("two approvals figure")),
  ]);
  return paymentPlanInput({
    now,
    invoices,
    counterparties,
    milestones,
    accounts,
    chainMode: chainModes().mode,
    walletHost: currentOrgConfig().chain.walletHost ?? null,
    budget,
    twoApprovalsAbove,
    ...(options.planned !== undefined ? { planned: options.planned } : {}),
  });
}
