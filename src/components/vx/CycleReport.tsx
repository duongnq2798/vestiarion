import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { orgHref } from "@/lib/auth/org-paths";
import type { CycleClockMode } from "@/lib/clock";
import type { LedgerEntry } from "@/lib/ledger";
import { entryOutcome, pad } from "./AuditLedger";
import { DOMAIN_CODE, DomainGlyph, OutcomeGlyph } from "./Glyphs";
import { MoreLink } from "./Treasury";

/**
 * The header, pinned as a pure function. Its count is every row the report
 * lists, the closing `cycle_complete` row included, so the header always
 * agrees with the visible list.
 */
export function cycleReportHeading(cycleName: string, rows: ReadonlyArray<unknown>): string {
  const n = rows.length;
  return `${cycleName}: the agent logged ${n} ${n === 1 ? "entry" : "entries"}`;
}

const OUTCOME_TEXT = { settled: "text-proof", refused: "text-refused", held: "text-held" } as const;

export function CycleReport({
  entries,
  day,
  since,
  clockMode,
  completedAt,
  orgSlug,
}: {
  entries: LedgerEntry[];
  day: number;
  since: number;
  clockMode: CycleClockMode;
  completedAt: string | null;
  orgSlug: string;
}) {
  const rows = entries.filter((entry) => entry.seq > since).sort((a, b) => a.seq - b.seq);
  if (rows.length === 0) return null;
  const cycleName = clockMode === "simulate" ? `Day ${day}` : completedAt ? new Date(completedAt).toLocaleString() : "Wall-clock cycle";
  return (
    <Card asChild tone="agent" className="mb-6 p-4 sm:p-5">
      <section aria-label={`${cycleName} cycle`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <Eyebrow className="text-agent">Cycle complete</Eyebrow>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-ink">{cycleReportHeading(cycleName, rows)}</h2>
          </div>
          <MoreLink href={orgHref(orgSlug, `/audit?since=${since}#seq-${rows.at(-1)!.seq}`)}>
            #{pad(rows[0].seq)}–#{pad(rows.at(-1)!.seq)} in the audit log
          </MoreLink>
        </div>
        <ol className="mt-4 divide-y divide-line rounded-xl border border-line">
          {rows.map((entry, index) => {
            const outcome = entryOutcome(entry);
            return (
              <li key={entry.seq} className="flex items-start gap-3 px-3 py-2 motion-safe:animate-arrive" style={{ animationDelay: `${100 + index * 55}ms` }}>
                <span className="mt-0.5 font-mono text-[0.6875rem] tabular-nums text-ink-3">#{pad(entry.seq)}</span>
                <span className="mt-0.5 inline-flex w-12 shrink-0 items-center gap-1 font-mono text-[0.6875rem] text-ink-3">
                  <DomainGlyph domain={entry.domain} className="size-2.5" />
                  {DOMAIN_CODE[entry.domain]}
                </span>
                <span className={cn("min-w-0 flex-1 text-sm", outcome === "refused" ? "text-refused" : "text-ink")}>{entry.summary}</span>
                {outcome && <OutcomeGlyph outcome={outcome} className={cn("mt-0.5 size-3.5", outcome in OUTCOME_TEXT ? OUTCOME_TEXT[outcome as keyof typeof OUTCOME_TEXT] : "text-ink-3")} />}
              </li>
            );
          })}
        </ol>
      </section>
    </Card>
  );
}
