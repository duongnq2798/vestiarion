import { ArrowUpRight, Download } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { WorkspaceMeta } from "@/components/vx/WorkspaceMeta";
import type { Portfolio, WorkspaceTriage } from "@/lib/accountant/read";
import {
  ageWords,
  applyFilter,
  countByAge,
  countByKind,
  KIND_TITLES,
  kindWords,
  TRIAGE_KINDS,
  type TriageItem,
  type TriageKind,
  type triageFilter,
} from "@/lib/accountant/triage";
import { orgHref } from "@/lib/auth/org-paths";
import { HOME_PATH } from "@/components/vx/nav";

/**
 * The accountant console (docs/superpowers/specs/2026-10-13-accountant-console-design.md A4 to A7): every workspace the
 * person is a member of, how long its items have been open, and one queue across them, each item linking into the page
 * of its own workspace where it is acted on. Presentational: the page reads the portfolio, and /docs-shots renders the
 * same component with sample data.
 *
 * It counts items and never adds money: each amount is shown on its own item, in its own currency.
 */

type Filter = ReturnType<typeof triageFilter>;

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

const KIND_TONE: Record<TriageKind, "refused" | "held" | "agent" | "neutral"> = {
  past_decide_by: "refused",
  decision: "held",
  customer_says_paid: "agent",
  disputed: "held",
  to_book: "agent",
  receivable_overdue: "held",
  connector: "refused",
  limit: "refused",
};

function hrefWith(filter: Filter, change: Partial<Filter>): string {
  const next = { ...filter, ...change };
  const params = new URLSearchParams();
  if (next.kind) params.set("kind", next.kind);
  if (next.workspace) params.set("workspace", next.workspace);
  if (next.mine) params.set("mine", "1");
  const query = params.toString();
  return query ? `/accountant?${query}` : "/accountant";
}

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-standard",
        active ? "border-agent-line bg-agent-soft text-agent" : "border-line-strong bg-surface text-ink-2 hover:border-agent-line hover:text-agent"
      )}
    >
      {children}
    </Link>
  );
}

function handoffHref(slug: string, format: "csv" | "json", month?: string): string {
  const params = new URLSearchParams({ org: slug, format });
  if (month) params.set("month", month);
  return `/api/accountant/handoff?${params.toString()}`;
}

function WorkspaceCard({ workspace, now, filter }: { workspace: WorkspaceTriage; now: Date; filter: Filter }) {
  const kinds = countByKind(workspace.items);
  const thisMonth = now.toISOString().slice(0, 7);
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastLabel = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(lastMonth);
  return (
    <Card className="flex min-w-0 flex-col gap-4 p-5" data-workspace={workspace.slug}>
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-3">
          <h3 className="truncate text-base font-semibold text-ink">{workspace.name}</h3>
          <Link
            href={hrefWith(filter, { workspace: filter.workspace === workspace.slug ? null : workspace.slug })}
            className="shrink-0 text-xs font-medium text-agent underline-offset-2 hover:underline"
          >
            {filter.workspace === workspace.slug ? "Show all" : "Only this one"}
          </Link>
        </div>
        <WorkspaceMeta mode={workspace.mode} network={workspace.network} role={workspace.role} className="mt-1" />
      </div>
      <div>
        <p className="text-[1.625rem] font-semibold tabular-nums leading-none tracking-tight text-ink">{workspace.items.length}</p>
        <p className="mt-1 text-xs text-ink-3">{workspace.items.length === 1 ? "item open" : "items open"}</p>
      </div>
      {kinds.length > 0 ? (
        <ul className="space-y-1 text-sm text-ink-2">
          {kinds.map(({ kind, count }) => (
            <li key={kind}>{kindWords(kind, count)}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-2">Nothing needs attention.</p>
      )}
      {workspace.unread.length > 0 && (
        <p className="text-xs text-held">Not read just now: {workspace.unread.join(", ")}. Open the workspace to check.</p>
      )}
      <div className="mt-auto space-y-2 border-t border-line pt-4">
        <Link href={orgHref(workspace.slug, HOME_PATH)} className="inline-flex items-center gap-1 text-sm font-medium text-agent underline-offset-2 hover:underline">
          Open workspace
          <ArrowUpRight aria-hidden className="size-3.5" />
        </Link>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
          <Download aria-hidden className="size-3.5 text-ink-3" />
          <span>Hand-off:</span>
          <a href={handoffHref(workspace.slug, "csv")} download className="font-medium text-agent underline-offset-2 hover:underline">
            {lastLabel} CSV
          </a>
          <a href={handoffHref(workspace.slug, "json")} download className="font-medium text-agent underline-offset-2 hover:underline">
            JSON
          </a>
          <span aria-hidden className="text-ink-3">·</span>
          <a href={handoffHref(workspace.slug, "csv", thisMonth)} download className="font-medium text-agent underline-offset-2 hover:underline">
            This month so far
          </a>
        </p>
      </div>
    </Card>
  );
}

function QueueItem({ item, now }: { item: TriageItem; now: Date }) {
  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:gap-4 sm:px-5" data-kind={item.kind}>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={KIND_TONE[item.kind]} size="sm" shape="tag">
            {KIND_TITLES[item.kind].one}
          </Badge>
          <span className="text-xs text-ink-3">{item.workspace.name}</span>
        </div>
        <p className="font-medium text-ink">
          {item.title}
          {item.amount && (
            <span className="ml-2 font-normal tabular-nums text-ink-2">
              {AMOUNT.format(item.amount.value)} {item.amount.currency}
            </span>
          )}
        </p>
        <p className="text-sm text-ink-2">{item.detail}</p>
        <p className={cn("text-xs", item.canAct ? "font-medium text-proof" : "text-ink-3")}>{item.who}</p>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-4 sm:flex-col sm:items-end sm:justify-start">
        <span className="text-xs tabular-nums text-ink-3">Open {ageWords(item.since, now).toLowerCase()}</span>
        <Link
          href={item.href}
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-line-strong bg-surface px-3 text-xs font-medium text-ink shadow-control transition-colors duration-150 ease-standard hover:border-agent-line hover:text-agent"
        >
          Open
          <ArrowUpRight aria-hidden className="size-3.5" />
        </Link>
      </div>
    </li>
  );
}

export function AccountantConsole({ portfolio, now, filter }: { portfolio: Portfolio; now: Date; filter: Filter }) {
  const shown = applyFilter(portfolio.items, filter);
  const ages = countByAge(portfolio.items, now);
  const mine = portfolio.items.filter((item) => item.canAct).length;
  const kindsPresent = TRIAGE_KINDS.filter((kind) => portfolio.items.some((item) => item.kind === kind));
  const filtered = filter.kind !== null || filter.workspace !== null || filter.mine;

  if (portfolio.workspaces.length === 0) {
    return (
      <EmptyState
        title="You are not in any workspace yet."
        body="When a business invites you, with the accountant role or another, its workspace shows here with what needs attention."
      />
    );
  }

  return (
    <div className="space-y-10">
      <section aria-labelledby="ages-title" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="ages-title" className="text-lg font-semibold text-ink">
            Open items by age
          </h2>
          <p className="text-sm text-ink-2">
            {portfolio.items.length} open across {portfolio.workspaces.length} {portfolio.workspaces.length === 1 ? "workspace" : "workspaces"}, {mine} you can act on
          </p>
        </div>
        <ol className="grid grid-cols-2 gap-3 sm:grid-cols-5" aria-label="Open items by age">
          {ages.map((bucket) => (
            <li key={bucket.key}>
              <Card tone={bucket.key === "older" && bucket.count > 0 ? "held" : undefined} className={cn("px-4 py-4", bucket.key === "older" && bucket.count > 0 && "bg-held-soft")}>
                <Eyebrow className={bucket.key === "older" && bucket.count > 0 ? "text-held" : undefined}>{bucket.label}</Eyebrow>
                <p className="mt-2 text-[1.375rem] font-semibold tabular-nums leading-none tracking-tight text-ink">{bucket.count}</p>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="workspaces-title" className="space-y-3">
        <h2 id="workspaces-title" className="text-lg font-semibold text-ink">
          Workspaces
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {portfolio.workspaces.map((workspace) => (
            <WorkspaceCard key={workspace.slug} workspace={workspace} now={now} filter={filter} />
          ))}
        </div>
      </section>

      <section aria-labelledby="queue-title" className="space-y-3">
        <div className="space-y-3">
          <h2 id="queue-title" className="text-lg font-semibold text-ink">
            What needs attention
          </h2>
          <nav aria-label="Narrow the queue" className="flex flex-wrap gap-2">
            <Chip href={hrefWith(filter, { kind: null, mine: false })} active={filter.kind === null && !filter.mine}>
              All
            </Chip>
            <Chip href={hrefWith(filter, { mine: !filter.mine })} active={filter.mine}>
              Yours to act on
            </Chip>
            {kindsPresent.map((kind) => (
              <Chip key={kind} href={hrefWith(filter, { kind: filter.kind === kind ? null : kind })} active={filter.kind === kind}>
                {KIND_TITLES[kind].many}
              </Chip>
            ))}
          </nav>
        </div>
        {shown.length === 0 ? (
          <Card className="p-5">
            <p className="text-sm text-ink-2">{filtered ? "Nothing matches this filter." : "Nothing needs attention in any of your workspaces."}</p>
          </Card>
        ) : (
          <Card asChild className="overflow-hidden">
            <ul className="divide-y divide-line" aria-label="Items">
              {shown.map((item) => (
                <QueueItem key={item.key} item={item} now={now} />
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}
