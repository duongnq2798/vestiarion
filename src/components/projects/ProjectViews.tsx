import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Money } from "@/components/vx/Primitives";
import { MoreLink } from "@/components/vx/Treasury";
import { StatTile } from "@/components/vx/StatTile";
import { utcDay } from "@/lib/copy";
import { formatMinor } from "@/lib/deals/money";
import type { PlanLine } from "@/lib/payment-plan";
import { figuresSentence, PROJECT_DIGITS, WORK_STATE_WORDS, type ProjectFigures, type ProjectWork } from "@/lib/projects/model";
import type { ProjectDeal, ProjectRevenue, ProjectSummary } from "@/lib/projects/read";

/**
 * What a project shows (docs/superpowers/specs/2026-10-13-project-budgets-design.md P7, P8): its budget, what is set
 * aside, paid and still available, the share of its open bills covered, the payments held for its budget, the revenue
 * its deals collected, its bills and milestones, its days in the 14-day payment plan, and the treasury it shares. Server
 * components; the forms are in `ProjectForms.tsx`.
 */

/** USDC cents as the figures show them. */
export function Cents({ minor, className }: { minor: number; className?: string }) {
  return <Money value={minor / 10 ** PROJECT_DIGITS} sign={minor < 0 ? "−" : undefined} className={className} />;
}

/** Said wherever a budget is shown: an earmark, never money locked on chain. */
export function EarmarkNote() {
  return (
    <Callout title="A budget here is an earmark, not a lock">
      Vestiarion counts what each project has set aside, so two bills never spend the same budget. Nothing is moved, locked or held on chain: the
      treasury stays one pool, the spending limit on Arc still counts only the workspace&apos;s daily and 7-day figures, and every payment still
      needs its cash when it is sent. A bill past its project&apos;s budget waits for a person in Approvals.
    </Callout>
  );
}

function revenueLine(revenue: ProjectRevenue): ReactNode {
  if (revenue.deals === 0) return "No deal in this project";
  const other = revenue.other.map((entry) => `${formatMinor(entry.minor, entry.digits)} ${entry.currency}`).join(", ");
  return `From ${revenue.deals === 1 ? "1 deal" : `${revenue.deals} deals`}, received on Arc${other ? `; also ${other}, counted apart` : ""}`;
}

function coverageLine(figures: ProjectFigures): string {
  if (figures.coveragePercent === null) return "Nothing open";
  return `${figures.coveragePercent}% of ${figures.openCount === 1 ? "1 open bill or milestone" : `${figures.openCount} open bills and milestones`} set aside`;
}

/** A project's figures: budget, set aside, paid, available, collected, and the two measures of how it is going. */
export function ProjectFigureTiles({ summary }: { summary: ProjectSummary }) {
  const { figures, revenue } = summary;
  return (
    <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
      <StatTile label="Budget" sub={figures.bufferMinor > 0 ? <>Of which <Cents minor={figures.bufferMinor} /> kept back as a buffer</> : "No buffer kept back"}>
        <Cents minor={figures.budgetMinor} />
      </StatTile>
      <StatTile label="Set aside" sub="For open bills and milestones, not paid yet">
        <Cents minor={figures.reservedMinor} />
      </StatTile>
      <StatTile label="Paid" sub="Bills and milestones of this project paid">
        <Cents minor={figures.paidMinor} />
      </StatTile>
      <StatTile label="Available" tone={figures.overMinor > 0 ? "held" : "default"} sub={figures.overMinor > 0 ? "Over its budget less the buffer" : "Left to set aside, after the buffer"}>
        <Cents minor={figures.availableMinor} className={figures.availableMinor < 0 ? "text-held" : undefined} />
      </StatTile>
      <StatTile label="Commitments covered" tone={figures.unreservedCount > 0 ? "held" : "default"} sub={coverageLine(figures)}>
        {figures.coveragePercent === null ? "—" : `${figures.coveragePercent}%`}
      </StatTile>
      <StatTile label="Held for its budget" tone={figures.holds.now > 0 ? "held" : "default"} sub={`${figures.holds.last30Days} held in the last 30 days`}>
        {figures.holds.now}
      </StatTile>
      <StatTile label="Collected" sub={revenueLine(revenue)}>
        <Cents minor={revenue.usdcMinor} />
      </StatTile>
      <StatTile label="Not set aside" tone={figures.unreservedMinor > 0 ? "held" : "default"} sub="Open, waiting for room in the budget">
        <Cents minor={figures.unreservedMinor} />
      </StatTile>
    </div>
  );
}

/** Every project of the workspace, each a card linking to its page. */
export function ProjectsList({ projects, hrefOf }: { projects: ProjectSummary[]; hrefOf: (projectId: string) => string }) {
  if (projects.length === 0) {
    return <EmptyState title="No projects yet" body="Make a project to give a job, a client or a launch its own budget. Then put its bills, milestones and deals in it." />;
  }
  return (
    <ul className="space-y-3" aria-label="Projects">
      {projects.map(({ project, figures, revenue }) => (
        <li key={project.id}>
          <Card asChild interactive className="block px-4 py-4">
            <Link href={hrefOf(project.id)}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="min-w-0 break-words text-base font-semibold tracking-tight text-ink">{project.name}</h3>
                <div className="flex flex-wrap gap-2">
                  {project.status === "archived" && <Badge size="sm">Archived</Badge>}
                  {figures.holds.now > 0 && (
                    <Badge size="sm" tone="held">
                      {figures.holds.now === 1 ? "1 held for its budget" : `${figures.holds.now} held for its budget`}
                    </Badge>
                  )}
                  {figures.overMinor > 0 && (
                    <Badge size="sm" tone="refused">
                      Over budget
                    </Badge>
                  )}
                </div>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[0.8125rem] sm:grid-cols-3 lg:grid-cols-6">
                <Figure label="Budget"><Cents minor={figures.budgetMinor} /></Figure>
                <Figure label="Set aside"><Cents minor={figures.reservedMinor} /></Figure>
                <Figure label="Paid"><Cents minor={figures.paidMinor} /></Figure>
                <Figure label="Available"><Cents minor={figures.availableMinor} className={figures.availableMinor < 0 ? "text-held" : undefined} /></Figure>
                <Figure label="Covered">{figures.coveragePercent === null ? "—" : `${figures.coveragePercent}%`}</Figure>
                <Figure label="Collected"><Cents minor={revenue.usdcMinor} /></Figure>
              </dl>
              <p className="mt-3 text-[0.8125rem] leading-snug text-ink-2">{figuresSentence(figures)}</p>
            </Link>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-3">{label}</dt>
      <dd className="mt-0.5 font-medium text-ink">{children}</dd>
    </div>
  );
}

const STATE_TONE = { reserved: "proof", not_reserved: "held", paid: "neutral", closed: "neutral" } as const;

/** A project's bills and milestones, each with what is set aside for it and why it waits, if it does. */
export function ProjectWorkList({ work, hrefOf, action }: { work: ProjectWork[]; hrefOf: (item: ProjectWork) => string; action?: (item: ProjectWork) => ReactNode }) {
  if (work.length === 0) return <EmptyState compact title="Nothing in this project yet" body="Put a bill or a milestone in it below, or choose this project when you add one." />;
  return (
    <ul className="divide-y divide-line rounded-xl border border-line bg-surface" aria-label="Bills and milestones">
      {work.map((item) => (
        <li key={`${item.kind}:${item.id}`} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <Link href={hrefOf(item)} className="break-words font-medium text-ink underline-offset-4 hover:underline">
              {item.label}
            </Link>
            <p className="mt-0.5 text-[0.8125rem] text-ink-2">
              {item.kind === "bill" ? "Bill" : "Milestone"}
              {item.counterpartyName ? ` · ${item.counterpartyName}` : ""}
              {item.dueOn ? ` · due ${utcDay(`${item.dueOn}T00:00:00Z`)}` : ""}
            </p>
            {(item.heldForBudget || item.heldAsSameWork) && (
              <p className="mt-1 text-[0.8125rem] text-held">
                {item.heldForBudget ? "Held for this project's budget: a person decides it in Approvals." : "Held as the same work as another bill or milestone: a person decides it."}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
            <Cents minor={item.amountMinor} className="text-sm font-medium" />
            <Badge size="sm" tone={STATE_TONE[item.state]}>
              {WORK_STATE_WORDS[item.state]}
            </Badge>
            {action?.(item)}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A project's deals, with what each collected. */
export function ProjectDealsList({ deals, hrefOf, action }: { deals: ProjectDeal[]; hrefOf: (dealId: string) => string; action?: (deal: ProjectDeal) => ReactNode }) {
  if (deals.length === 0) return <EmptyState compact title="No deal in this project" body="Put a deal in it to count what the deal collects here." />;
  return (
    <ul className="divide-y divide-line rounded-xl border border-line bg-surface" aria-label="Deals">
      {deals.map((deal) => (
        <li key={deal.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <Link href={hrefOf(deal.id)} className="break-words font-medium text-ink underline-offset-4 hover:underline">
              {deal.title}
            </Link>
            <p className="mt-0.5 text-[0.8125rem] text-ink-2">
              {deal.customer} · {formatMinor(deal.totalMinor, deal.digits)} {deal.currency} in all
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 text-sm sm:justify-end">
            <span className="text-ink-2">Collected</span>
            <span className="font-medium tabular-nums text-ink">{deal.collectedMinor === null ? "not read" : `${formatMinor(deal.collectedMinor, deal.digits)} ${deal.currency}`}</span>
            {action?.(deal)}
          </div>
        </li>
      ))}
    </ul>
  );
}

const PLAN_STATE_WORDS: Record<PlanLine["state"], string> = {
  planned: "Planned",
  on_its_way: "On its way",
  waiting: "Waits for a person",
  not_counted: "Not counted",
};

/**
 * The project's lines of the 14-day payment plan: the plan of the whole treasury, since cash is one pool, with only this
 * project's bills and milestones listed. Days and balances are the whole plan's.
 */
export function ProjectPlan({ lines, through, planHref }: { lines: PlanLine[] | null; through: string | null; planHref: string }) {
  if (lines === null) return <Callout>The payment plan could not be read just now. Reload the page in a moment.</Callout>;
  if (lines.length === 0) {
    return <EmptyState compact title="Nothing of this project in the next 14 days" body="Its open bills and milestones fall due later, or wait for a person." action={<Link href={planHref} className="text-sm font-medium text-agent underline-offset-4 hover:underline">The whole payment plan</Link>} />;
  }
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line rounded-xl border border-line bg-surface" aria-label="This project in the payment plan">
        {lines.map((line) => (
          <li key={`${line.kind}:${line.id}`} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="break-words font-medium text-ink">{line.title ?? line.payee}</p>
              <p className="mt-0.5 text-[0.8125rem] text-ink-2">
                {line.on ? utcDay(`${line.on}T00:00:00Z`) : "No day in the window"}
                {line.title ? ` · ${line.payee}` : ""} · {line.reason}
              </p>
              {line.flags.length > 0 && <p className="mt-1 text-[0.8125rem] text-held">{line.flags.map((flag) => flag.text).join(" ")}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-2 sm:justify-end">
              <Money value={line.pays} className="text-sm font-medium" />
              <Badge size="sm" tone={line.state === "waiting" ? "held" : line.state === "on_its_way" ? "agent" : "neutral"}>
                {PLAN_STATE_WORDS[line.state]}
              </Badge>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-[0.8125rem] text-ink-2">
        The days and balances are the whole treasury&apos;s, through {through ? utcDay(`${through}T00:00:00Z`) : "the next 14 days"}: every project pays from one pool.{" "}
        <Link href={planHref} className="font-medium text-agent underline-offset-4 hover:underline">
          The whole payment plan
        </Link>
      </p>
    </div>
  );
}

/**
 * The treasury from the project's side: the one pool every project shares, what every project has set aside, and this
 * project's share. Cash, read from the plan; null when it could not be read.
 */
export function ProjectCash({ cash, setAsideAllMinor, summary, dueIn14DaysMinor }: { cash: number | null; setAsideAllMinor: number; summary: ProjectSummary; dueIn14DaysMinor: number | null }) {
  const cashMinor = cash === null ? null : Math.round(cash * 100);
  const short = cashMinor !== null && cashMinor < setAsideAllMinor ? setAsideAllMinor - cashMinor : 0;
  return (
    <Card className="px-4 py-4">
      <SectionHeader title="Treasury for this project" meta="One pool, shared by every project" className="mb-2" />
      <dl className="grid grid-cols-1 gap-3 text-sm min-[420px]:grid-cols-2 lg:grid-cols-4">
        <Figure label="Cash in the treasury">{cash === null ? "Not read" : <Money value={cash} />}</Figure>
        <Figure label="Set aside, every project"><Cents minor={setAsideAllMinor} /></Figure>
        <Figure label="Set aside, this project"><Cents minor={summary.figures.reservedMinor} /></Figure>
        <Figure label="This project pays, next 14 days">{dueIn14DaysMinor === null ? "Not read" : <Cents minor={dueIn14DaysMinor} />}</Figure>
      </dl>
      <p className="mt-3 text-[0.8125rem] leading-snug text-ink-2">
        {cashMinor === null
          ? "The treasury's cash could not be read just now."
          : short > 0
            ? `The cash is ${formatMinor(short, PROJECT_DIGITS)} USDC short of what every project has set aside. Set aside is not paid: each bill still waits for its cash when it is due.`
            : "The cash covers what every project has set aside. Set aside is not reserved in a wallet: bills outside projects draw on the same cash."}
      </p>
    </Card>
  );
}

/**
 * Treasury's Projects card: each active project's money set aside and what it has left, beside the one pool of cash
 * they share. Hidden when the workspace has no active project.
 */
export function ProjectsTreasuryCard({ projects, allHref, hrefOf }: { projects: ProjectSummary[]; allHref: string; hrefOf: (projectId: string) => string }) {
  const active = projects.filter((entry) => entry.project.status === "active");
  if (active.length === 0) return null;
  const setAside = active.reduce((sum, entry) => sum + entry.figures.reservedMinor, 0);
  return (
    <Card asChild className="overflow-hidden">
      <section>
        <div className="px-4 pt-4 sm:px-5">
          <SectionHeader title="Projects" meta={<>set aside <Cents minor={setAside} />, an earmark, not locked</>} action={<MoreLink href={allHref}>All projects</MoreLink>} />
        </div>
        <ul className="divide-y divide-line border-t border-line">
          {active.slice(0, 5).map(({ project, figures }) => (
            <li key={project.id} className="px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <Link href={hrefOf(project.id)} className="min-w-0 truncate text-sm font-medium text-ink underline-offset-4 hover:underline">
                  {project.name}
                </Link>
                <span className="text-sm text-ink-2">
                  <Cents minor={figures.reservedMinor} /> set aside
                </span>
              </div>
              <p className={figures.overMinor > 0 || figures.holds.now > 0 ? "mt-0.5 text-[0.8125rem] text-held" : "mt-0.5 text-[0.8125rem] text-ink-3"}>
                {figuresSentence(figures)}
                {figures.holds.now > 0 ? ` ${figures.holds.now === 1 ? "1 payment waits" : `${figures.holds.now} payments wait`} for a person.` : ""}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </Card>
  );
}
