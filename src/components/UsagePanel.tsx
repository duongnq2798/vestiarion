import Link from "next/link";
import { DocsLink } from "@/components/DocsLink";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { cn } from "@/components/ui/cn";
import { orgHref } from "@/lib/auth/org-paths";
import { actionLabel, costWords, KIND_LABELS, type LimitState, type UsageKindSummary, type UsageLimit } from "@/lib/usage/model";
import type { UsageMonthView } from "@/lib/usage/read";

/**
 * A workspace's usage this month and its limits, in Settings (docs/superpowers/specs/2026-10-13-accountant-console-design.md
 * U3, U4): each kind of use with its count, the tokens a model reported and its cost per currency where known, never
 * added across currencies; then each limit with what stops when it is reached and who acts. Attribution only: nothing
 * here is a bill.
 */

const STATE_BADGE: Record<LimitState, { tone: "proof" | "held" | "refused"; words: string }> = {
  ok: { tone: "proof", words: "Within limit" },
  near: { tone: "held", words: "Near the limit" },
  reached: { tone: "refused", words: "Stopped" },
};

const count = (value: number, [one, many]: [string, string]) => `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;

function CostCell({ line }: { line: Pick<UsageKindSummary, "costs" | "costUnknown" | "count"> }) {
  if (line.count === 0) return <span className="text-ink-3">—</span>;
  if (line.costs.length === 0) return <span className="text-ink-3">Not known</span>;
  return (
    <span className="tabular-nums">
      {line.costs.map(costWords).join(" + ")}
      {line.costUnknown > 0 && <span className="text-ink-3"> ({line.costUnknown.toLocaleString("en-US")} without a cost)</span>}
    </span>
  );
}

function tokensWords(line: Pick<UsageKindSummary, "inputTokens" | "outputTokens">): string | null {
  if (line.inputTokens === 0 && line.outputTokens === 0) return null;
  return `${line.inputTokens.toLocaleString("en-US")} in, ${line.outputTokens.toLocaleString("en-US")} out`;
}

export function UsageLimits({ orgSlug, limits }: { orgSlug: string; limits: UsageLimit[] }) {
  if (limits.length === 0) return null;
  return (
    <ul className="divide-y divide-line" aria-label="Limits">
      {limits.map((limit) => {
        const badge = STATE_BADGE[limit.state];
        return (
          <li key={`${limit.key}-${limit.title}`} className="space-y-1.5 py-4 first:pt-0 last:pb-0" data-limit={limit.key} data-state={limit.state}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="font-medium text-ink">{limit.title}</p>
              <Badge tone={badge.tone} size="sm" dot>
                {badge.words}
              </Badge>
              <p className="text-sm tabular-nums text-ink-2">{limit.used}</p>
            </div>
            <p className={cn("text-sm", limit.state === "reached" ? "text-ink" : "text-ink-2")}>{limit.stops}</p>
            <p className="text-sm text-ink-2">
              <span className="font-medium text-ink">Who acts: </span>
              {limit.who}{" "}
              <Link href={orgHref(orgSlug, limit.path)} className="font-medium text-agent underline-offset-2 hover:underline">
                Open
              </Link>
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export function UsageTable({ kinds }: { kinds: UsageKindSummary[] }) {
  return (
    // Wide enough that each kind's lines stay readable on a phone, where the table scrolls sideways in its own frame.
    <Table label="Usage this month" className="min-w-[40rem]">
      <TableHeader>
        <TableRow>
          <TableHead>What</TableHead>
          <TableHead className="text-right">Count</TableHead>
          <TableHead>Model tokens</TableHead>
          <TableHead>Cost where known</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {kinds.map((kind) => (
          <TableRow key={kind.kind} data-usage-kind={kind.kind}>
            <TableCell className="align-top">
              <p className="font-medium">{KIND_LABELS[kind.kind].title}</p>
              {kind.lines.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-ink-2">
                  {kind.lines.map((line) => (
                    <li key={line.action}>
                      {actionLabel(line.action)}: {count(line.count, KIND_LABELS[kind.kind].unit)}
                      {line.failed > 0 && <span className="text-held"> ({line.failed.toLocaleString("en-US")} failed)</span>}
                    </li>
                  ))}
                </ul>
              )}
            </TableCell>
            <TableCell className="text-right align-top tabular-nums">{kind.count.toLocaleString("en-US")}</TableCell>
            <TableCell className="align-top text-ink-2 tabular-nums">{kind.kind === "model_call" ? (tokensWords(kind) ?? "—") : "—"}</TableCell>
            <TableCell className="align-top">
              <CostCell line={kind} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function UsagePanel({ orgSlug, usage, limits }: { orgSlug: string; usage: UsageMonthView | null; limits: UsageLimit[] }) {
  const stopped = limits.filter((limit) => limit.state === "reached");
  return (
    <section aria-labelledby="usage-title" id="usage">
      <SectionHeader
        id="usage-title"
        title="Usage this month"
        meta={usage ? usage.month.label : undefined}
        action={<DocsLink href="/docs/guides/accountants#6-usage-and-limits" topic="usage and limits" />}
      />
      <Card className="space-y-6 p-5">
        {stopped.length > 0 && (
          <p role="status" className="rounded-xl border border-refused-line bg-refused-soft px-4 py-3 text-sm text-ink">
            <span className="font-semibold">{stopped.length === 1 ? "One limit has stopped something." : `${stopped.length} limits have stopped something.`}</span>{" "}
            {stopped.map((limit) => limit.title).join(", ")}: what stopped and who acts are below.
          </p>
        )}
        <div className="space-y-3">
          <p className="text-sm text-ink-2">
            What this workspace used since the 1st (UTC): the agent&apos;s model calls, Circle transfers, x402 purchases, emails and connector syncs. Costs are
            shown in their own currency, where the provider or the price is known, and never added across currencies. This is a record, not a bill.
          </p>
          {usage === null ? (
            <p className="text-sm text-ink-2">Usage could not be read just now. Reload the page to try again.</p>
          ) : !usage.available ? (
            <p className="text-sm text-ink-2">Usage is not recorded on this deployment yet.</p>
          ) : (
            <>
              <UsageTable kinds={usage.summary.kinds} />
              {usage.summary.partial && <p className="text-xs text-ink-3">More was used than one page shows: each figure is at least this much.</p>}
            </>
          )}
        </div>
        <div className="space-y-3 border-t border-line pt-5">
          <h3 className="text-sm font-semibold text-ink">Limits</h3>
          {limits.length === 0 ? <p className="text-sm text-ink-2">No limit applies to this workspace now.</p> : <UsageLimits orgSlug={orgSlug} limits={limits} />}
        </div>
      </Card>
    </section>
  );
}
