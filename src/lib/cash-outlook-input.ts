import type { OutlookInput } from "./cash-outlook";
import type { InvoiceRow, MilestoneRow } from "./queries";

/** The invoice fields the outlook reads. */
export type OutlookInvoice = Pick<InvoiceRow, "id" | "direction" | "counterparty_name" | "amount" | "currency" | "due_date" | "status" | "scheduled_for">;
/** The milestone fields the outlook reads. */
export type OutlookMilestone = Pick<MilestoneRow, "id" | "title" | "contractor_name" | "amount" | "status" | "escrow_state">;

/**
 * The cash outlook's input from the workspace's rows as `listAccounts`, `listInvoices` and `listMilestones` read them:
 * one mapping, so `/today` and the cash alert (docs/superpowers/specs/2026-10-17-cash-short-alert-design.md S1) work
 * out the same figures. Deal lines are not read here.
 */
export function outlookInputOf(input: { now: number; accounts: Array<{ kind: string; balance: number }>; invoices: OutlookInvoice[]; milestones: OutlookMilestone[] }): OutlookInput {
  const { accounts, invoices, milestones } = input;
  return {
    now: input.now,
    operatingUsdc: Number(accounts.find((account) => account.kind === "operating")?.balance ?? 0),
    reserveUsdc: Number(accounts.find((account) => account.kind === "reserve")?.balance ?? 0),
    payables: invoices
      .filter((invoice) => invoice.direction === "payable")
      .map((invoice) => ({
        id: invoice.id,
        counterparty: invoice.counterparty_name,
        amount: invoice.amount,
        currency: invoice.currency ?? null,
        due_date: invoice.due_date,
        status: invoice.status,
        scheduled_for: invoice.scheduled_for ?? null,
      })),
    milestones: milestones.map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      contractor: milestone.contractor_name,
      amount: milestone.amount,
      status: milestone.status,
      escrow_state: milestone.escrow_state ?? null,
    })),
    receivables: invoices
      .filter((invoice) => invoice.direction === "receivable")
      .map((invoice) => ({
        id: invoice.id,
        counterparty: invoice.counterparty_name,
        amount: invoice.amount,
        currency: invoice.currency ?? null,
        due_date: invoice.due_date,
        status: invoice.status,
      })),
  };
}
