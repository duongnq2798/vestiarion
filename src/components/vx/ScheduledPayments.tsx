import { amountToPay, invoiceDiscount } from "@/lib/agent/payment-timing";
import { utcDay } from "@/lib/copy";
import type { InvoiceRow } from "@/lib/queries";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Money, Reasoning } from "./Primitives";

/** How many scheduled payables the console shows before the rest wait for the Invoices page. */
const MAX_ROWS = 5;

/** One row of the console's "Scheduled payments" section. */
export interface ScheduledPaymentRow {
  id: string;
  counterparty: string;
  /** ISO timestamp — the console formats it, the same `utcDay` as everywhere else. */
  date: string;
  /** What the agent will actually transfer on that day: discounted, when the discount still applies then. */
  amount: number;
  /** The first sentence of the agent's reasoning. */
  reasoning: string;
}

/** The text up to (and including) its first ". ", or all of it when there is no second sentence. */
function firstSentence(text: string): string {
  const end = text.indexOf(". ");
  return end === -1 ? text : text.slice(0, end + 1);
}

/**
 * Up to 5 scheduled payables, soonest first, with the amount the agent will
 * actually pay on the day (the discount, when it still applies then) and the
 * headline of why. Derived from the invoices the console already loads with
 * `listInvoices()` — this reads no new query of its own.
 */
export function scheduledPaymentRows(invoices: ReadonlyArray<InvoiceRow>): ScheduledPaymentRow[] {
  return invoices
    .filter((invoice): invoice is InvoiceRow & { scheduled_for: string } => invoice.status === "scheduled" && invoice.scheduled_for != null)
    .sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for))
    .slice(0, MAX_ROWS)
    .map((invoice) => ({
      id: invoice.id,
      counterparty: invoice.counterparty_name,
      date: invoice.scheduled_for,
      amount: amountToPay(invoice.amount, invoiceDiscount(invoice), new Date(invoice.scheduled_for)).amountPaid,
      reasoning: firstSentence(invoice.agent_reasoning ?? ""),
    }));
}

/** What the agent will pay next: hidden entirely when nothing is scheduled. */
export function ScheduledPayments({ payments }: { payments: ScheduledPaymentRow[] }) {
  if (payments.length === 0) return null;
  return (
    <Card asChild className="overflow-hidden">
      <section>
        <div className="px-4 pt-4 sm:px-5">
          <SectionHeader title="Scheduled payments" meta="soonest first" />
        </div>
        <ul className="divide-y divide-line border-t border-line">
          {payments.map((payment) => (
            <li key={payment.id} className="px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="min-w-0 truncate text-sm font-medium text-ink">{payment.counterparty}</span>
                <Money value={payment.amount} className="text-sm text-ink" />
              </div>
              <p className="mt-0.5 font-mono text-xs text-ink-3">{utcDay(payment.date)}</p>
              {payment.reasoning && <Reasoning text={payment.reasoning} className="mt-1 text-[0.8125rem]" />}
            </li>
          ))}
        </ul>
      </section>
    </Card>
  );
}
