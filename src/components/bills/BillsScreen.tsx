import type { ReactNode } from "react";
import { BILLS_TABS, type BillsTab, type ReviewPanel } from "@/lib/bills-view";
import { BillsList } from "./BillsList";
import { DetailPanel, LegacyHashRedirect, ReviewPanels, type PanelContent } from "./BillsPanels";
import { BillsSummary, ReviewStrip, type SummaryData, type WaitingItem } from "./BillsSummary";
import { BillsTabs, panelId, tabId, type BillsTabLink } from "./BillsTabs";
import type { ListData } from "./types";

export interface BillsScreenProps {
  /** The page's own address for a workspace path: `orgHref(slug, path)`. */
  slugHref: (path: string) => string;
  tab: BillsTab;
  tabs: BillsTabLink[];
  summary: SummaryData;
  waiting: WaitingItem[];
  reviews: Partial<Record<ReviewPanel, PanelContent>>;
  /** The details of the rows shown, and of a bill the address opens. */
  details: Record<string, PanelContent>;
  /** The tab shown: Bills' list and its Schedules; the plan; Receivables' list, with Apply payments above and Deals below. */
  bills?: { list: ListData; above?: ReactNode; below?: ReactNode };
  plan?: ReactNode;
  receivables?: { list: ListData; above?: ReactNode; below?: ReactNode };
}

/**
 * Bills & receivables under its title (docs/superpowers/specs/2026-10-12-bills-tabs-design.md): the figures, what waits
 * for review, the three tabs and the one shown, and the panels over them. It reads nothing: the page prepares every row,
 * card and form, and /docs-shots renders it with sample data.
 */
export function BillsScreen({ slugHref, tab, tabs, summary, waiting, reviews, details, bills, plan, receivables }: BillsScreenProps) {
  const content: Record<BillsTab, ReactNode> = {
    bills: bills ? <BillsList list={bills.list} slugHref={slugHref} above={bills.above} below={bills.below} /> : null,
    plan: plan ?? null,
    receivables: receivables ? <BillsList list={receivables.list} slugHref={slugHref} above={receivables.above} below={receivables.below} /> : null,
  };
  return (
    <>
      <LegacyHashRedirect />
      <BillsSummary data={summary} />
      <ReviewStrip items={waiting} />
      <BillsTabs tabs={tabs} active={tab} />
      {BILLS_TABS.map((key) =>
        key === tab ? (
          <div key={key} role="tabpanel" id={panelId(key)} aria-labelledby={tabId(key)} tabIndex={0} className="rounded-xl outline-offset-4">
            {content[key]}
          </div>
        ) : (
          <div key={key} role="tabpanel" id={panelId(key)} aria-labelledby={tabId(key)} hidden />
        )
      )}
      <DetailPanel details={details} />
      <ReviewPanels reviews={reviews} />
    </>
  );
}
