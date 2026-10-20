import { CircleCheck, Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { addDays, customerRequestWords, dayWords, money, PROMISE_MAX_DAYS, type CustomerRequest, type StatementLine, type StatementView as View } from "@/lib/customer-portal/model";
import { utcDay } from "@/lib/copy";
import { StatementActions, StatementReply, type StatementForm } from "./StatementActions";

/**
 * A customer's statement (docs/superpowers/specs/2026-10-13-customer-portal-design.md P3, I16): what it owes the business
 * in each currency, its open invoices by due day with what is still owed, how late and what it said about each, and
 * what it paid recently. It names only what the customer already knows: the business, itself, its own invoices, and the
 * business's replies under the business's name. One column at every width, so it reads the same on a phone.
 */

const FIGURE = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function StatementView({ view, token, openForm }: { view: View; token: string; openForm?: { invoiceId: string; form: StatementForm } | null }) {
  const latestPaid = addDays(view.today, 1);
  const latestPromise = addDays(view.today, PROMISE_MAX_DAYS);
  return (
    <article className="space-y-8" aria-labelledby="statement-title">
      <header className="space-y-2">
        <p>
          <Eyebrow className="text-agent">Statement</Eyebrow>
        </p>
        <h1 id="statement-title" className="text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-3xl">
          What {view.customerName} owes {view.orgName}
        </h1>
        <p className="text-sm text-ink-2">
          As of {dayWords(view.today)}. This link works until {utcDay(view.expiresAt)}.
        </p>
      </header>

      <section aria-label="What you owe" className="grid gap-3 sm:grid-cols-2">
        {view.totals.length === 0 ? (
          <div className="rounded-2xl border border-line bg-surface p-5 shadow-flat sm:col-span-2">
            <p className="flex items-center gap-2 text-sm font-medium text-proof">
              <CircleCheck aria-hidden className="size-4" />
              Nothing is owed. Thank you.
            </p>
          </div>
        ) : (
          view.totals.map((total) => (
            <div key={total.currency} className="rounded-2xl border border-line bg-surface p-5 shadow-flat">
              <Eyebrow>You owe</Eyebrow>
              <p className="mt-1 text-3xl font-semibold tabular-nums tracking-[-0.02em] text-ink">
                {FIGURE.format(total.owed)} <span className="text-base font-medium text-ink-2">{total.currency}</span>
              </p>
              <p className="mt-1 text-sm text-ink-2">
                {plural(total.open, "open invoice", "open invoices")}
                {total.overdue > 0 ? ` · ${money(total.overdue, total.currency)} overdue` : ""}
              </p>
            </div>
          ))
        )}
      </section>

      {view.open.length > 0 && (
        <section aria-labelledby="open-invoices" className="space-y-3">
          <h2 id="open-invoices" className="text-lg font-semibold text-ink">
            Open invoices
          </h2>
          <ul className="space-y-4">
            {view.open.map((line) => (
              <li key={line.id}>
                <OpenInvoice line={line} view={view} token={token} latestPaid={latestPaid} latestPromise={latestPromise} openForm={openForm?.invoiceId === line.id ? openForm.form : null} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.paid.length > 0 && (
        <section aria-labelledby="paid-invoices" className="space-y-3">
          <h2 id="paid-invoices" className="text-lg font-semibold text-ink">
            Paid recently
          </h2>
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface shadow-flat">
            {view.paid.map((line) => (
              <li key={line.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
                <span className="min-w-0 break-words text-sm font-medium text-ink">{line.label}</span>
                <span className="text-sm tabular-nums text-ink-2">
                  {money(line.amount, line.currency)}
                  {line.paidOn ? ` · paid ${dayWords(line.paidOn)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-xs leading-5 text-ink-3">
        This page shows only your own invoices with {view.orgName}. Anyone with this link can see it and send {view.orgName} a message as you, so share
        it only with the people who handle your payments. What you say here is a message to {view.orgName}: an invoice is paid when they receive the
        payment.
      </p>
    </article>
  );
}

function OpenInvoice({
  line,
  view,
  token,
  latestPaid,
  latestPromise,
  openForm,
}: {
  line: StatementLine;
  view: View;
  token: string;
  latestPaid: string;
  latestPromise: string;
  openForm: StatementForm | null;
}) {
  const askedPayLink = line.requests.some((request) => request.kind === "pay_link" && request.status === "open");
  return (
    <article aria-labelledby={`invoice-${line.id}`} className="rounded-2xl border border-line bg-surface p-5 shadow-flat sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={`invoice-${line.id}`} className="min-w-0 break-words text-base font-semibold text-ink">
          {line.label}
        </h3>
        {line.state === "overdue" ? (
          <Badge tone="refused" dot>
            {`Overdue ${plural(line.overdueDays, "day", "days")}`}
          </Badge>
        ) : (
          <Badge tone="neutral" icon={<Clock3 aria-hidden />}>
            {`Due ${dayWords(line.dueDate)}`}
          </Badge>
        )}
      </div>
      <p className="mt-3 text-2xl font-semibold tabular-nums tracking-[-0.01em] text-ink">
        {FIGURE.format(line.owed)} <span className="text-sm font-medium text-ink-2">{line.currency}</span>
      </p>
      <p className="text-sm text-ink-2">
        {line.received > 0 ? `Still owed. Received ${FIGURE.format(line.received)} of ${money(line.amount, line.currency)}.` : "To pay"}
      </p>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-3">Due</dt>
        <dd className="text-ink">{dayWords(line.dueDate)}</dd>
        {line.reference && (
          <>
            <dt className="text-ink-3">Reference</dt>
            <dd className="break-words text-ink">{line.reference}</dd>
          </>
        )}
      </dl>

      {line.requests.length > 0 && (
        <ul aria-label="What you told them" className="mt-4 space-y-3 border-t border-line pt-4">
          {line.requests.map((request) => (
            <li key={request.id}>
              <RequestItem request={request} line={line} view={view} token={token} />
            </li>
          ))}
        </ul>
      )}

      <StatementActions
        token={token}
        invoiceId={line.id}
        label={line.label}
        owed={FIGURE.format(line.owed)}
        currency={line.currency}
        orgName={view.orgName}
        today={view.today}
        latestPaid={latestPaid}
        latestPromise={latestPromise}
        payUrl={line.payUrl}
        canAskPayLink={!line.payUrl && !askedPayLink}
        defaultOpen={openForm}
      />
    </article>
  );
}

function RequestItem({ request, line, view, token }: { request: CustomerRequest; line: StatementLine; view: View; token: string }) {
  const words = customerRequestWords(request, { orgName: view.orgName, currency: line.currency, today: view.today, payUrl: line.payUrl });
  const open = request.status === "open";
  return (
    <div className={open ? "space-y-2" : "space-y-1"}>
      <p className="text-sm font-medium text-ink">{words.title}</p>
      {words.detail && <p className="break-words text-xs text-ink-3">{words.detail}</p>}
      <p className="text-sm text-ink-2">{words.status}</p>
      {request.messages.length > 0 && (
        <ol aria-label="Messages" className="space-y-2">
          {request.messages.map((message) => (
            <li key={message.id} className={message.author === "customer" ? "rounded-xl bg-ground px-3 py-2" : "rounded-xl border border-agent-line bg-agent-soft px-3 py-2"}>
              <p className="text-xs font-medium text-ink-3">
                {message.author === "customer" ? "You" : view.orgName} · {utcDay(message.createdAt)}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-ink">{message.body}</p>
            </li>
          ))}
        </ol>
      )}
      {open && <StatementReply token={token} requestId={request.id} orgName={view.orgName} />}
    </div>
  );
}
