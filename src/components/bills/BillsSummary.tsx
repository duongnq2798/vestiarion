import Link from "next/link";
import type { ReactNode } from "react";
import { Money } from "@/components/vx/Primitives";
import { StatTile } from "@/components/vx/StatTile";
import { ReviewButton } from "./BillsPanels";
import type { ReviewPanel } from "@/lib/bills-view";

/** An amount in USDC with any EURC beside it: the two are never added together. */
export interface Totals {
  usdc: number;
  eurc: number;
}

export interface SummaryData {
  needsYou: { count: number; href: string };
  dueSoon: { count: number; totals: Totals; href: string };
  overdue: { count: number; totals: Totals; href: string };
  /** What customers still owe on open receivables, part payments taken off: money owed, never cash. */
  receivables: { open: number; overdue: number; owed: Totals; href: string };
}

export function TotalsLine({ totals }: { totals: Totals }) {
  return (
    <>
      <Money value={totals.usdc} />
      {totals.eurc > 0 && (
        <>
          {" "}
          + <Money value={totals.eurc} token="EURC" />
        </>
      )}
    </>
  );
}

/**
 * The page's figures, kept above the tabs (docs/superpowers/specs/2026-10-12-bills-tabs-design.md B10): what needs a
 * person, what falls due within 7 days, what is overdue, and what customers owe. Each opens the tab and filter that list
 * them, so its number is that list's length.
 */
export function BillsSummary({ data }: { data: SummaryData }) {
  const { needsYou, dueSoon, overdue, receivables } = data;
  return (
    <div className="mb-4 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
      <StatTile label="Needs you" tone={needsYou.count > 0 ? "held" : "default"} href={needsYou.href} sub={needsYou.count > 0 ? "Bills waiting for a person" : "Nothing waiting"}>
        <span className="tabular-nums">{needsYou.count}</span>
      </StatTile>
      <StatTile label="Due in 7 days" href={dueSoon.href} sub={dueSoon.count > 0 ? <TotalsLine totals={dueSoon.totals} /> : "Nothing due this week"}>
        <span className="tabular-nums">{dueSoon.count}</span>
      </StatTile>
      <StatTile label="Overdue" tone={overdue.count > 0 ? "held" : "default"} href={overdue.href} sub={overdue.count > 0 ? <TotalsLine totals={overdue.totals} /> : "Nothing past its due date"}>
        <span className="tabular-nums">{overdue.count}</span>
      </StatTile>
      <StatTile
        label="Receivables"
        href={receivables.href}
        sub={
          receivables.open === 0
            ? "Nothing owed to you"
            : `Owed to you · ${receivables.open} open${receivables.overdue > 0 ? `, ${receivables.overdue} overdue` : ""}`
        }
      >
        <TotalsLine totals={receivables.owed} />
      </StatTile>
    </div>
  );
}

/** One item of Waiting for review: a list opened over the page, or a place on the page. */
export interface WaitingItem {
  key: string;
  label: string;
  review?: ReviewPanel;
  href?: string;
}

/**
 * What waits for a person to review, in one line, only when something does (B11): bills an accounting tool brought in,
 * payments to book in it, invoices that came by email, won deals to plan. Each opens its existing review.
 */
export function ReviewStrip({ items }: { items: WaitingItem[] }): ReactNode {
  if (items.length === 0) return null;
  return (
    <div role="region" aria-label="Waiting for review" className="mb-5 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-xl border border-line bg-surface/70 px-4 py-2.5 text-[0.8125rem]">
      <span className="font-semibold text-ink">Waiting for review</span>
      <ul className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {items.map((item, index) => (
          <li key={item.key} className="flex items-baseline gap-2">
            {index > 0 && (
              <span aria-hidden className="text-ink-3">
                ·
              </span>
            )}
            {item.review ? (
              <ReviewButton review={item.review}>{item.label}</ReviewButton>
            ) : (
              <Link href={item.href ?? "#"} className="font-medium text-agent underline-offset-4 hover:underline">
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
