import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { chipVariants } from "@/components/ui/chip";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Money, OutcomeBadge } from "@/components/vx/Primitives";
import { RowLink } from "./BillsPanels";
import { SortSelect } from "./SortSelect";
import type { BillRowItem, ListData } from "./types";

/**
 * A tab's list on Bills & receivables (docs/superpowers/specs/2026-10-12-bills-tabs-design.md B6, B8, B9): its quick
 * filters with their counts, the search and the order, one row per bill, 25 to a page. A row says who, what, when, how
 * much, where it stands, what is in its way and what to do next; its name opens its detail.
 */
export function BillsList({ list, slugHref, above, below }: { list: ListData; slugHref: (path: string) => string; above?: ReactNode; below?: ReactNode }) {
  const { page } = list;
  return (
    <div className="space-y-4">
      <nav aria-label={`Filter ${list.label.toLowerCase()}`} className="flex flex-wrap gap-1.5">
        {list.filters.map((chip) => (
          <Link key={chip.key} href={chip.href} scroll={false} aria-current={chip.current ? "true" : undefined} className={chipVariants({ selected: chip.current })}>
            {chip.label}
            <span className={cn("font-mono tabular-nums", chip.current ? "text-ink-2" : "text-ink-3")}>{chip.count}</span>
          </Link>
        ))}
      </nav>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {/* Search Bills & receivables by more than a name (I09): an address, so a search can be linked. */}
        <form method="get" role="search" aria-label={`Search ${list.label.toLowerCase()}`} className="flex min-w-0 flex-1 items-center gap-2">
          {Object.entries(list.keep).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <Input
            name="q"
            type="search"
            defaultValue={list.q ?? ""}
            maxLength={100}
            aria-label="Search by invoice number, id, purchase order, counterparty, amount or transaction"
            placeholder="Invoice number, PO, counterparty or amount"
            className="min-w-0 flex-1 sm:max-w-md"
          />
          <Button type="submit" variant="secondary" icon={<Search />}>
            Search
          </Button>
        </form>
        <SortSelect value={list.sort} options={list.sorts} />
      </div>

      {list.q && (
        <Callout icon={<Search />}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              Showing what matches <span className="font-mono">{list.q}</span>: {page.total} {page.total === 1 ? "invoice" : "invoices"}
              {list.elsewhere && (
                <>
                  {" · "}
                  <Link href={list.elsewhere.href} className="font-medium text-agent underline-offset-2 hover:underline">
                    {list.elsewhere.text}
                  </Link>
                </>
              )}
            </span>
            <Button asChild variant="link" className="ml-auto">
              <Link href={list.clearSearchHref} scroll={false}>
                Clear search
              </Link>
            </Button>
          </div>
        </Callout>
      )}

      {above}

      {page.total === 0 ? (
        <EmptyState compact title={list.empty.title} body={list.empty.body} action={list.empty.action} />
      ) : (
        <Card className="overflow-hidden">
          <ul aria-label={list.label} className="divide-y divide-line">
            {page.rows.map((row) => (
              <li key={row.id}>
                <Row row={row} slugHref={slugHref} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {page.total > 0 && (
        <nav aria-label={`${list.label}, pages`} className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
          <span className="tabular-nums">
            {page.from}–{page.to} of {page.total}
          </span>
          {page.pages > 1 && (
            <span className="flex items-center gap-2">
              <PageLink href={list.previousHref} label="Previous" icon={<ChevronLeft aria-hidden />} />
              <span className="tabular-nums">
                Page {page.page} of {page.pages}
              </span>
              <PageLink href={list.nextHref} label="Next" icon={<ChevronRight aria-hidden />} after />
            </span>
          )}
        </nav>
      )}

      {below}
    </div>
  );
}

function PageLink({ href, label, icon, after = false }: { href: string | null; label: string; icon: ReactNode; after?: boolean }) {
  if (!href) {
    return (
      <span aria-disabled="true" className="inline-flex h-8 items-center gap-1 rounded-lg border border-line px-3 text-xs font-semibold text-ink-3 opacity-60">
        {!after && icon}
        {label}
        {after && icon}
      </span>
    );
  }
  return (
    <Button asChild variant="secondary" size="sm">
      <Link href={href} scroll={false}>
        {!after && icon}
        {label}
        {after && icon}
      </Link>
    </Button>
  );
}

/** What the row asks next: a page that does it, the detail where its action is, or a fact. */
function NextAction({ row, slugHref }: { row: BillRowItem; slugHref: (path: string) => string }) {
  const next = row.next;
  if (!next) return null;
  const tone = next.tone === "held" ? "text-held" : next.tone === "agent" ? "text-agent" : "text-ink-3";
  const words = (
    <>
      <span className="font-medium md:hidden">Next: </span>
      <span className="sr-only max-md:hidden">Next: </span>
      {next.text}
    </>
  );
  if (next.tone === "muted") return <span className={cn("relative text-xs", tone)}>{words}</span>;
  const className = cn("relative z-10 text-xs font-medium underline-offset-2 hover:underline", tone);
  if (next.href) {
    return (
      <Link href={slugHref(next.href)} className={className}>
        {words}
        <ChevronRight aria-hidden className="ml-0.5 inline size-3.5 align-[-0.2em]" />
      </Link>
    );
  }
  return (
    <RowLink id={row.id} href={row.href} className={className}>
      {words}
      <ChevronRight aria-hidden className="ml-0.5 inline size-3.5 align-[-0.2em]" />
    </RowLink>
  );
}

/** One row: on a phone, stacked; from 768 px, columns for the date, the amount and where it stands. */
function Row({ row, slugHref }: { row: BillRowItem; slugHref: (path: string) => string }) {
  const below = row.blockers.length > 0 ? null : row.why;
  return (
    <div className="relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 px-4 py-3 transition-colors duration-150 ease-standard hover:bg-ground/50 sm:px-5 md:grid-cols-[minmax(0,1fr)_7.5rem_8.5rem_minmax(0,14rem)] md:items-start">
      <div className="min-w-0">
        <p className="flex min-w-0 items-baseline gap-2">
          <RowLink id={row.id} href={row.href} stretched className="min-w-0 truncate text-sm font-medium text-ink outline-offset-2 hover:underline">
            {row.name}
            <span className="sr-only">, details</span>
          </RowLink>
          {row.justAdded && <span className="shrink-0 text-xs font-medium text-agent">Just added</span>}
        </p>
        <p className="truncate text-xs text-ink-3">{row.reference ?? "No reference"}</p>
        {row.date && <p className={cn("font-mono text-xs md:hidden", row.date.tone === "held" ? "text-held" : "text-ink-2")}>{row.date.label}</p>}
        {row.context && <p className="truncate text-xs text-agent">{row.context}</p>}
        {row.note && <p className="text-xs text-ink-2">{row.note}</p>}
        {row.blockers.length > 0 && (
          <ul aria-label="In the way" className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs font-medium text-held">
            {row.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        )}
        {below && <p className="mt-1 text-xs leading-5 text-ink-2">{below}</p>}
        {row.collection && <p className="mt-0.5 text-xs text-ink-2">{row.collection}</p>}
      </div>
      <div className="hidden md:block md:pt-0.5">
        {row.date && <span className={cn("whitespace-nowrap font-mono text-xs", row.date.tone === "held" ? "text-held" : "text-ink-2")}>{row.date.label}</span>}
      </div>
      <div className="text-right md:pt-0.5">
        {row.amount != null && <Money value={row.amount} token={row.token} struck={row.struck} className={cn("text-sm font-semibold", row.struck ? "text-ink-3" : "text-ink")} />}
      </div>
      <div className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 md:col-span-1 md:flex-col md:items-start">
        <OutcomeBadge outcome={row.outcome} label={row.outcomeLabel} />
        <NextAction row={row} slugHref={slugHref} />
      </div>
    </div>
  );
}
