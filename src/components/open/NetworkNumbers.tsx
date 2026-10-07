import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { Disclosure } from "@/components/ui/Disclosure";
import { utcDay } from "@/lib/copy";
import type { NetworkProfile } from "@/lib/network";
import { dailySeries, type OpenNumbers, type Period, type SideNumbers } from "@/lib/platform/open-numbers";
import { DECIDED_BY_AGENT, formatFigure, formatPercent, formatRatio, OpenNumbersTable, partOf, type OpenRow } from "./OpenNumbersTable";
import { OurPayments } from "./OurPayments";
import { PaymentsChart } from "./PaymentsChart";
import { SectionHead } from "./SectionHead";

/**
 * One network's open numbers, read top down as a visitor asks: do customers use
 * it, does money settle, does the agent act on its own and how did that turn
 * out, what stops it, and can I check it. Headline figures are customers'
 * (with the total beside them), since a team testing its own product proves
 * little; the agent's figures cover every workspace, said so on the section.
 * Every figure is also in the full table at the end, customers, ours and the
 * total side by side.
 */
export function NetworkNumbers({ numbers, period, network }: { numbers: OpenNumbers; period: Period; network: NetworkProfile }) {
  const { customers, total } = numbers.sides;
  const latest = numbers.daily.filter((row) => row.customers + row.ours > 0).map((row) => row.day).sort().at(-1);
  const id = network.id;

  return (
    <div className="mt-6 space-y-14">
      {latest && (
        <p className="-mt-2 inline-flex items-center gap-2 text-sm text-ink-2">
          <span aria-hidden className="size-2 rounded-full bg-proof" />
          Latest payment settled on <time dateTime={latest}>{utcDay(`${latest}T00:00:00Z`)}</time>
        </p>
      )}

      <section aria-labelledby={`customers-${id}`}>
        <SectionHead id={`customers-${id}`} eyebrow="Customers" title="Real customer usage">
          Workspaces opened by people outside the Vestiarion team. Each figure has the total with our own workspaces beneath it.
        </SectionHead>
        <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-3">
          <Kpi label="Customer workspaces opened" value={formatFigure(customers.workspacesOpened, "count")} total={formatFigure(total.workspacesOpened, "count")}>
            Each one opened by someone outside the team.
          </Kpi>
          <Kpi label="Customer workspaces live" now value={formatFigure(customers.liveWorkspaces, "count")} total={formatFigure(total.liveWorkspaces, "count")}>
            Running on {network.label} as this page was read.
          </Kpi>
          <Kpi label="Reached a first payment" value={formatFigure(customers.firstPayments, "count")} total={formatFigure(total.firstPayments, "count")}>
            Customer workspaces whose first payment settled.
          </Kpi>
          <Kpi label="Payments settled" value={formatFigure(customers.payments, "count")} total={formatFigure(total.payments, "count")}>
            Confirmed by Circle on {network.label}.
          </Kpi>
          <Kpi label="USDC paid" value={formatFigure(customers.usdcPaid, "usdc")} unit="USDC" total={`${formatFigure(total.usdcPaid, "usdc")} USDC`}>
            Settled to {formatFigure(customers.payees, "count")} payee {customers.payees === 1 ? "wallet" : "wallets"}.
          </Kpi>
          <Kpi
            label="Median time to first payment"
            value={formatFigure(customers.medianMinutesToFirstPayment, "duration")}
            total={formatFigure(total.medianMinutesToFirstPayment, "duration")}
          >
            From opening a workspace to its first settled payment.
          </Kpi>
        </div>
        <p className="mt-3 text-xs leading-5 text-ink-3">Customers&apos; payments are counted here, never listed one by one.</p>
      </section>

      <section aria-labelledby={`agent-${id}`}>
        <SectionHead id={`agent-${id}`} eyebrow="All workspaces" title="How the agent performs">
          What the agent did with the payment decisions it made, and how those payments turned out. Customers&apos; share is beneath each.
        </SectionHead>
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Share
            label="Decided by the agent itself"
            row={DECIDED_BY_AGENT}
            total={total}
            customers={customers}
            unit="payment decisions"
            note="Paid, sent or scheduled without waiting for anyone; the rest went to a person."
          />
          <Share
            label="Invoices paid on time"
            row={{ key: "invoicesPaidOnTime", label: "", kind: "period", format: "ratio", of: ["invoicesPaidOnArc"] }}
            total={total}
            customers={customers}
            unit="invoices paid"
            note="Settled on or before the invoice's due day."
          />
          <Share
            label="On time, no person involved"
            row={{ key: "invoicesPaidOnTimeUntouched", label: "", kind: "period", format: "ratio", of: ["invoicesPaidOnArc"] }}
            total={total}
            customers={customers}
            unit="invoices paid"
            note="Nobody approved, rejected or returned the invoice."
          />
          <Share
            label="Agent flags upheld"
            row={{ key: "flagsUpheld", label: "", kind: "period", format: "ratio", of: ["flagsResolved"] }}
            total={total}
            customers={customers}
            unit="flags a person decided"
            note="The agent said not to pay, and the person who decided agreed."
          />
        </div>
      </section>

      <section aria-labelledby={`controls-${id}`}>
        <SectionHead id={`controls-${id}`} eyebrow="All workspaces" title="What stands between the model and the money">
          A model never moves money on its say-so. Every payment decision passes the same checks before money moves, and each is counted here, the uncomfortable ones too.
        </SectionHead>
        <ol className="mt-5 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-5">
          <Step n={1} title="A model proposes" figure={formatFigure(total.modelDecisions, "count")} measure="decisions made by a model">
            In {formatFigure(total.cycles, "count")} agent cycles, deciding {formatFigure(total.invoicesDecided, "count")} invoices.
          </Step>
          <Step n={2} title="Compared with the written policy" figure={formatFigure(total.policyDepartures, "count")} measure="times the model disagreed">
            The written rule-based policy decides every case beside the model, so each disagreement is recorded, not hidden.
          </Step>
          <Step n={3} title="Hard limits in code" figure={formatFigure(total.refusedByCode, "count")} measure="decisions refused by code" tone="held">
            A decision that breaks a hard limit is refused, whatever proposed it. {formatFigure(total.duplicatesCaught, "count")} duplicate{" "}
            {total.duplicatesCaught === 1 ? "invoice" : "invoices"} caught before payment.
          </Step>
          <Step n={4} title="A person when it matters" figure={formatFigure(total.decisionsEscalated, "count")} measure="decisions escalated to a person">
            {formatFigure(total.escalationsResolved, "count")} resolved by a person so far.
          </Step>
          <Step n={5} title={`Settles on ${network.label}`} figure={formatFigure(total.payments, "count")} measure="payments settled" tone="proof">
            {formatFigure(total.milestonesReleased, "count")} of them paid contractor milestones.
          </Step>
        </ol>
      </section>

      <PaymentsChart series={dailySeries(numbers.daily, period)} network={network} />

      <OurPayments payments={numbers.ourPayments} network={network} />

      <section aria-labelledby={`figures-${id}`}>
        <SectionHead id={`figures-${id}`} eyebrow="For auditors" title="Every figure">
          Customers, our own workspaces and the total, side by side, for {period.label.toLowerCase()}.
        </SectionHead>
        <Disclosure className="mt-5" summary="Show every figure for customers, our workspaces and the total">
          <OpenNumbersTable numbers={numbers} period={period} />
        </Disclosure>
      </section>
    </div>
  );
}

/** A customers' headline figure, with what it means and the total beside it. */
function Kpi({ label, value, unit, total, now, children }: { label: string; value: string; unit?: string; total: string; now?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col bg-surface p-4 sm:p-6">
      <p className="text-sm font-medium text-ink">
        {label}
        {now && <span className="ml-2 font-mono text-[0.6875rem] uppercase tracking-[0.11em] text-ink-3">now</span>}
      </p>
      <p className="mt-3 text-[1.75rem] font-semibold leading-none tracking-[-0.03em] text-ink sm:text-[2.5rem]">
        {value}
        {unit && value !== "—" && <span className="ml-1.5 text-sm sm:text-base font-medium tracking-normal text-ink-3">{unit}</span>}
      </p>
      <p className="mb-4 mt-3 flex-1 text-xs leading-5 text-ink-2 sm:text-[0.8125rem]">{children}</p>
      <p className="border-t border-line pt-3 font-mono text-[0.6875rem] text-ink-3 sm:text-xs">
        With our workspaces: <span className="text-ink-2">{total}</span>
      </p>
    </div>
  );
}

/** A share of a whole, as a percent with its meter, the counts behind it, and customers' own. */
function Share({ label, row, total, customers, unit, note }: { label: string; row: OpenRow; total: SideNumbers; customers: SideNumbers; unit: string; note: string }) {
  const all = partOf(total, row);
  const theirs = partOf(customers, row);
  return (
    <div className="flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-5">
      <p className="text-sm font-medium text-ink">{label}</p>
      <p className={cn("mt-3 text-[2.25rem] font-semibold leading-none tracking-[-0.03em]", all ? "text-agent" : "text-ink-3")}>
        {all ? formatPercent(all.part, all.whole) : "—"}
      </p>
      <span aria-hidden className="mt-3 block h-1.5 overflow-hidden rounded-full bg-agent-soft">
        {all && <span className="block h-full rounded-full bg-agent" style={{ width: `${(100 * all.part) / all.whole}%` }} />}
      </span>
      <p className="mt-2 font-mono text-xs text-ink-2">{all ? `${formatRatio(all.part, all.whole)} ${unit}` : "Nothing to measure yet"}</p>
      <p className="mb-4 mt-3 flex-1 text-[0.8125rem] leading-5 text-ink-2">{note}</p>
      <p className="border-t border-line pt-3 font-mono text-xs text-ink-3">
        Customers: <span className="text-ink-2">{theirs ? `${formatPercent(theirs.part, theirs.whole)} (${formatRatio(theirs.part, theirs.whole)})` : "—"}</span>
      </p>
    </div>
  );
}

const STEP_TONE = { default: "text-ink", held: "text-held", proof: "text-proof" } as const;

/** One step a payment decision passes, with the figure that counts it. */
function Step({
  n,
  title,
  figure,
  measure,
  tone = "default",
  children,
}: {
  n: number;
  title: string;
  figure: string;
  measure: string;
  tone?: keyof typeof STEP_TONE;
  children: ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col bg-surface p-5">
      <p className="flex items-center gap-2 text-sm font-medium text-ink">
        <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-full border border-line-strong font-mono text-[0.6875rem] text-ink-3">
          {n}
        </span>
        {title}
      </p>
      <p className={cn("mt-4 text-[1.75rem] font-semibold leading-none tracking-[-0.03em]", STEP_TONE[tone])}>{figure}</p>
      <p className="mt-1.5 text-xs font-medium text-ink-2">{measure}</p>
      <p className="mt-3 text-[0.8125rem] leading-5 text-ink-2">{children}</p>
    </li>
  );
}
