import Link from "next/link";
import { orgHref } from "@/lib/auth/org-paths";
import type { LedgerEntry } from "@/lib/ledger";
import type { CycleClockMode } from "@/lib/clock";
import { entryOutcome, pad } from "./AuditLedger";
import { DOMAIN_CODE, DomainGlyph, OutcomeGlyph } from "./Glyphs";
import { Label } from "./Primitives";

/**
 * The header's entry count, pinned as a pure function: every row the report
 * lists, minus the closing `cycle_complete` row when the report includes it.
 * It no longer excludes non-"system"-domain rows the way the old "decisions"
 * count did — that count disagreed with the `cycle_complete` ledger entry's
 * own count whenever the cycle also ran a compliance sweep.
 */
export function cycleReportEntryCount(rows: Array<Pick<LedgerEntry, "action">>): number {
  const closesWithCycleComplete = rows.some((row) => row.action === "cycle_complete");
  return rows.length - (closesWithCycleComplete ? 1 : 0);
}

export function CycleReport({ entries, day, since, clockMode, completedAt, orgSlug }: { entries: LedgerEntry[]; day: number; since: number; clockMode: CycleClockMode; completedAt: string | null; orgSlug: string }) {
  const rows = entries.filter((entry) => entry.seq > since).sort((a, b) => a.seq - b.seq);
  if (rows.length === 0) return null;
  const n = cycleReportEntryCount(rows);
  const cycleName = clockMode === "simulate" ? `Day ${day}` : completedAt ? new Date(completedAt).toLocaleString() : "Wall-clock cycle";
  return (
    <section aria-label={`${cycleName} cycle`} className="mb-6 rounded-lg border border-agent-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <Label className="text-agent">Cycle complete</Label>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-ink">{cycleName}: the agent logged {n} {n === 1 ? "entry" : "entries"}</h2>
        </div>
        <Link href={orgHref(orgSlug, `/audit?since=${since}#seq-${rows.at(-1)!.seq}`)} className="text-[0.8125rem] text-agent hover:underline">#{pad(rows[0].seq)}–#{pad(rows.at(-1)!.seq)} in the audit log →</Link>
      </div>
      <ol className="mt-4 divide-y divide-line rounded-md border border-line">
        {rows.map((entry, index) => {
          const outcome = entryOutcome(entry);
          return (
            <li key={entry.seq} className="flex items-start gap-3 px-3 py-2 motion-safe:animate-arrive" style={{ animationDelay: `${100 + index * 55}ms` }}>
              <span className="mt-0.5 font-mono text-[0.6875rem] tabular-nums text-ink-3">#{pad(entry.seq)}</span>
              <span className="mt-0.5 inline-flex w-12 shrink-0 items-center gap-1 font-mono text-[0.6875rem] text-ink-3"><DomainGlyph domain={entry.domain} className="size-2.5" />{DOMAIN_CODE[entry.domain]}</span>
              <span className={`min-w-0 flex-1 text-sm ${outcome === "refused" ? "text-refused" : "text-ink"}`}>{entry.summary}</span>
              {outcome && <OutcomeGlyph outcome={outcome} className={`mt-0.5 size-3.5 ${outcome === "settled" ? "text-proof" : outcome === "refused" ? "text-refused" : outcome === "held" ? "text-held" : "text-ink-3"}`} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
