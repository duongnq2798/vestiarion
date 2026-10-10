import { agentBudgetStatus } from "./agent-budget";
import { readTwoApprovalsAbove } from "./approval-policy";
import { chainModes } from "./circle";
import { currentOrgConfig } from "./context";
import { db } from "./dal";
import { planPayments, type PaymentPlan } from "./payment-plan";
import { paymentPlanInput } from "./payment-plan-input";
import { listAccounts, listCounterparties, listInvoices, listMilestones, type CounterpartyRow, type InvoiceRow } from "./queries";

/**
 * The payment plan as the workspace in scope stands now (docs/superpowers/specs/2026-10-11-payment-plan-design.md):
 * read for Bills & receivables, which passes the invoices and counterparties it already loaded, and read again by the
 * command that approves a line, so a stale plan is refused (P11). The limits and the milestones are best effort: one
 * that cannot be read is named on the plan, and approving waits for it (P12). The accounts are not: without the cash
 * there is no plan, and the read throws.
 */
export async function readPaymentPlan(options: { now?: number; invoices?: InvoiceRow[]; counterparties?: CounterpartyRow[] } = {}): Promise<PaymentPlan> {
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
  return planPayments(
    paymentPlanInput({
      now,
      invoices,
      counterparties,
      milestones,
      accounts,
      chainMode: chainModes().mode,
      walletHost: currentOrgConfig().chain.walletHost ?? null,
      budget,
      twoApprovalsAbove,
    })
  );
}
