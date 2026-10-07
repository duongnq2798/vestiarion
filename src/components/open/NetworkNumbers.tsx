import { ArrowDown, ArrowRight, Blocks, Bot, ScrollText, ShieldCheck, UserCheck, type LucideIcon } from "lucide-react";
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
    <div className="mt-6 space-y-20 sm:space-y-24">
      {latest && (
        <p className="-mt-2 inline-flex items-center gap-2 text-sm text-ink-2">
          <span aria-hidden className="size-2 rounded-full bg-proof" />
          Latest payment settled on <time dateTime={latest}>{utcDay(`${latest}T00:00:00Z`)}</time>
        </p>
      )}

      <section aria-labelledby={`customers-${id}`}>
        <SectionHead id={`customers-${id}`} eyebrow="Customers" title={`Customers on ${network.label}`}>
          Workspaces opened on {network.label} by people outside the Vestiarion team. Each figure has the total with our own workspaces beneath it.
        </SectionHead>
        <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-3">
          <Kpi label="Customer workspaces opened" value={milestone(customers.workspacesOpened, period)} total={formatFigure(total.workspacesOpened, "count")}>
            Each one opened by someone outside the team.
          </Kpi>
          <Kpi label="Customer workspaces live" now value={milestone(customers.liveWorkspaces, period)} total={formatFigure(total.liveWorkspaces, "count")}>
            Running on {network.label} as this page was read.
          </Kpi>
          <Kpi label="Reached a first payment" value={milestone(customers.firstPayments, period)} total={formatFigure(total.firstPayments, "count")}>
            Customer workspaces whose first payment settled.
          </Kpi>
          <Kpi label="Payments settled" value={milestone(customers.payments, period)} total={formatFigure(total.payments, "count")}>
            Confirmed by Circle on {network.label}.
          </Kpi>
          <Kpi
            label="USDC paid"
            value={customers.usdcPaid === 0 ? "—" : formatFigure(customers.usdcPaid, "usdc")}
            unit="USDC"
            total={`${formatFigure(total.usdcPaid, "usdc")} USDC`}
          >
            {customers.usdcPaid === 0 ? (
              `No customer payment on ${network.label} ${period.key === "all" ? "yet" : "in this period"}.`
            ) : (
              <>
                Settled to {formatFigure(customers.payees, "count")} payee {customers.payees === 1 ? "wallet" : "wallets"}.
              </>
            )}
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
        <ol className="mt-6 flex flex-col lg:flex-row lg:items-stretch">
          <Step stage="Model" icon={Bot} title="A model proposes" figure={formatFigure(total.modelDecisions, "count")} measure="decisions made by a model" first>
            In {formatFigure(total.cycles, "count")} agent cycles, deciding {formatFigure(total.invoicesDecided, "count")} invoices.
          </Step>
          <Step stage="Policy" icon={ScrollText} title="Compared with the written policy" figure={formatFigure(total.policyDepartures, "count")} measure="times the model disagreed">
            The written rule-based policy decides every case beside the model, so each disagreement is recorded, not hidden.
          </Step>
          <Step stage="Code" icon={ShieldCheck} title="Hard limits in code" figure={formatFigure(total.refusedByCode, "count")} measure="decisions refused by code" tone="held">
            A decision that breaks a hard limit is refused, whatever proposed it. {formatFigure(total.duplicatesCaught, "count")} duplicate{" "}
            {total.duplicatesCaught === 1 ? "invoice" : "invoices"} caught before payment.
          </Step>
          <Step stage="Person" icon={UserCheck} title="A person when it matters" figure={formatFigure(total.decisionsEscalated, "count")} measure="decisions escalated to a person">
            {formatFigure(total.escalationsResolved, "count")} resolved by a person so far.
          </Step>
          <Step stage="Chain" icon={Blocks} title={`Settles on ${network.label}`} figure={formatFigure(total.payments, "count")} measure="payments settled" tone="proof">
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

/**
 * A customers' count that marks how far adoption has come. Zero reads as a step
 * not reached, "Not yet" over all time and "None" within a period, rather than a
 * row of zeros; the figures table beneath still gives the number.
 */
function milestone(value: number | null, period: Period): string {
  if (value === 0) return period.key === "all" ? "Not yet" : "None";
  return formatFigure(value, "count");
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
      <p className="mb-4 mt-3 flex-1 text-sm leading-6 text-ink-2">{children}</p>
      <p className="border-t border-line pt-3 font-mono text-xs text-ink-3">
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
      <p className="mb-4 mt-3 flex-1 text-sm leading-6 text-ink-2">{note}</p>
      <p className="border-t border-line pt-3 font-mono text-xs text-ink-3">
        Customers: <span className="text-ink-2">{theirs ? `${formatPercent(theirs.part, theirs.whole)} (${formatRatio(theirs.part, theirs.whole)})` : "—"}</span>
      </p>
    </div>
  );
}

const STEP_TONE = { default: "text-ink", held: "text-held", proof: "text-proof" } as const;

/**
 * One stage a payment decision passes, with the figure that counts it. The
 * stages read as a pipeline: an arrow leads into every stage but the first,
 * across on a wide screen and down on a narrow one.
 */
function Step({
  stage,
  icon: Icon,
  title,
  figure,
  measure,
  tone = "default",
  first = false,
  children,
}: {
  stage: string;
  icon: LucideIcon;
  title: string;
  figure: string;
  measure: string;
  tone?: keyof typeof STEP_TONE;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col lg:flex-1 lg:flex-row">
      {!first && (
        <span aria-hidden className="flex items-center justify-center py-1.5 text-ink-3 lg:px-1.5 lg:py-0">
          <ArrowDown className="size-4 lg:hidden" />
          <ArrowRight className="hidden size-4 lg:block" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col rounded-2xl border border-line bg-surface p-5">
        <p className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold uppercase tracking-[0.1em] text-agent">
          <Icon aria-hidden className="size-3.5" />
          {stage}
        </p>
        <p className="mt-2 text-sm font-semibold leading-snug text-ink lg:min-h-[2.5rem]">{title}</p>
        <p className={cn("mt-4 text-[2rem] font-semibold leading-none tracking-[-0.03em]", STEP_TONE[tone])}>{figure}</p>
        <p className="mt-1.5 text-sm font-medium text-ink-2">{measure}</p>
        <p className="mt-3 text-sm leading-6 text-ink-2">{children}</p>
      </div>
    </li>
  );
}

const ON_TIME: OpenRow = { key: "invoicesPaidOnTime", label: "", kind: "period", format: "ratio", of: ["invoicesPaidOnArc"] };

/**
 * The handful of figures a visitor should see before scrolling, from the
 * network that leads the page and named as its, never added across networks
 * (network foundation N7). Each says whose it is: customers' alone, or every
 * workspace's.
 */
export function Headline({ numbers, period, network }: { numbers: OpenNumbers; period: Period; network: NetworkProfile }) {
  const { customers, total } = numbers.sides;
  const onTime = partOf(total, ON_TIME);
  return (
    <section aria-labelledby="headline" className="mt-10">
      <h2 id="headline" className="font-mono text-xs font-semibold uppercase tracking-[0.11em] text-ink-3">
        {network.label} · {period.label}
      </h2>
      <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-4">
        <HeadlineFigure label="Customer workspaces" value={milestone(customers.workspacesOpened, period)}>
          {customers.workspacesOpened === 0
            ? `None opened by anyone outside the team ${period.key === "all" ? "yet" : "in this period"}`
            : `${formatFigure(customers.liveWorkspaces, "count")} live now, ${formatFigure(customers.firstPayments, "count")} made a first payment`}
        </HeadlineFigure>
        <HeadlineFigure label="Payments settled" value={formatFigure(total.payments, "count")}>
          {customers.payments === 0 ? "None" : formatFigure(customers.payments, "count")} by customers, {formatFigure(total.usdcPaid, "usdc")} USDC in all
        </HeadlineFigure>
        <HeadlineFigure label="Invoices paid on time" value={onTime ? formatPercent(onTime.part, onTime.whole) : "—"}>
          {onTime ? `${formatRatio(onTime.part, onTime.whole)}, every workspace` : "Nothing to measure yet"}
        </HeadlineFigure>
        <HeadlineFigure label="Median time to a customer's first payment" value={formatFigure(customers.medianMinutesToFirstPayment, "duration")}>
          From opening a workspace to its first settled payment
        </HeadlineFigure>
      </dl>
    </section>
  );
}

function HeadlineFigure({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col bg-surface p-4 sm:p-6">
      <dt className="order-2 mt-3 text-sm font-semibold text-ink">{label}</dt>
      <dd className="order-1 text-[2rem] font-semibold leading-none tracking-[-0.035em] text-ink sm:text-5xl">{value}</dd>
      <dd className="order-3 mt-1 text-sm leading-6 text-ink-2">{children}</dd>
    </div>
  );
}

/**
 * A network where workspaces are live but no payment has settled in the
 * period: a few facts and every figure behind a disclosure, instead of a
 * dashboard of zeros. It grows into the full section with its first payment.
 */
export function QuietNetwork({ numbers, period, network }: { numbers: OpenNumbers; period: Period; network: NetworkProfile }) {
  const { customers, total } = numbers.sides;
  const facts: ReadonlyArray<[string, string]> = [
    ["Workspaces live", formatFigure(total.liveWorkspaces, "count")],
    ["Customers' workspaces live", formatFigure(customers.liveWorkspaces, "count")],
    ["Agent cycles run", formatFigure(total.cycles, "count")],
    ["Payments settled", formatFigure(total.payments, "count")],
  ];
  return (
    <div className="mt-4 rounded-2xl border border-line bg-surface p-5">
      <p className="text-[0.9375rem] font-semibold text-ink">
        No payment has settled on {network.label} {period.key === "all" ? "yet" : "in this period"}.
      </p>
      <p className="mt-1 text-sm leading-6 text-ink-2">Its figures show here in full once one does.</p>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-4">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-ink-3">{label}</dt>
            <dd className="mt-0.5 text-xl font-semibold tracking-tight text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <Disclosure variant="bare" className="mt-4" summaryClassName="text-sm font-medium text-agent hover:underline" summary="Show every figure">
        <div className="mt-3">
          <OpenNumbersTable numbers={numbers} period={period} label={`Every figure on ${network.label}`} />
        </div>
      </Disclosure>
    </div>
  );
}
