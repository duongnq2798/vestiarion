import type { AutonomyLadder, LadderRow } from "@/lib/autonomy-ladder";
import { plural } from "@/lib/copy";
import { VERDICTS_BEFORE_LIVE } from "@/lib/workspace-report";

/**
 * How often the owner agreed with the agent, by decision and by vendor, under the report's Before a live slice
 * (docs/superpowers/specs/2026-10-26-autonomy-ladder-design.md AL7): what agreement means here said first (AL1, AL3),
 * then a count of verdicts behind every figure, and no percentage under five (AL4). It only measures.
 */
export function AgreementLadder({ ladder }: { ladder: AutonomyLadder }) {
  return (
    <section aria-labelledby="report-agreement" className="space-y-4">
      <div>
        <h3 id="report-agreement" className="text-sm font-semibold text-ink">
          How often you agreed, by decision and by vendor
        </h3>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-3">
          {"From your verdicts in shadow mode: each Agree or Disagree you gave on one of the agent's decisions about a real bill, sample data left out."}{" "}
          A bill the agent decided twice can carry two verdicts. This is not Agent vs what really happened, below, which compares the agent with what your
          business paid. {`Under ${VERDICTS_BEFORE_LIVE} verdicts, a row says too few to tell yet.`} It only measures: nothing here changes what the agent may
          do.
        </p>
      </div>
      {ladder.given === 0 ? (
        <p className="text-sm text-ink-2">No verdict on a real bill yet. Give one on a decision in Bills & receivables, and it is counted here.</p>
      ) : (
        <>
          <LadderTable title="By decision" column="Decision" rows={ladder.byKind} />
          <LadderTable title="By vendor" column="Vendor" rows={ladder.byVendor} meta="Most verdicts first" />
        </>
      )}
    </section>
  );
}

/** From `sm`, one line per row; on a phone, the name and its count over the figure, so nothing scrolls sideways (AL7). */
const COLUMNS = "sm:grid-cols-[minmax(0,1fr)_5rem_minmax(0,11rem)]";

function LadderTable({ title, column, rows, meta }: { title: string; column: string; rows: LadderRow[]; meta?: string }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h4 className="text-[0.8125rem] font-semibold text-ink">{title}</h4>
        {meta && <span className="text-xs text-ink-3">{meta}</span>}
      </div>
      <div role="table" aria-label={title} className="rounded-xl border border-line text-sm">
        <div role="row" className={`hidden border-b border-line px-3 py-2 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-ink-3 sm:grid sm:gap-3 ${COLUMNS}`}>
          <span role="columnheader">{column}</span>
          <span role="columnheader" className="text-right">
            Verdicts
          </span>
          <span role="columnheader">Agreed</span>
        </div>
        {rows.map((row) => (
          <div role="row" key={row.key} className={`grid gap-1 border-b border-line px-3 py-2.5 last:border-b-0 sm:items-baseline sm:gap-3 ${COLUMNS}`}>
            <span role="cell" className="min-w-0 break-words font-medium text-ink">
              {row.label}
              <span className="font-normal text-ink-3 sm:hidden">{` · ${row.given} ${plural(row.given, "verdict", "verdicts")}`}</span>
            </span>
            <span role="cell" className="hidden text-right tabular-nums sm:block">
              {row.given}
            </span>
            <span role="cell" className="tabular-nums text-ink-2">
              {row.rate === null ? (
                "Too few to tell yet"
              ) : (
                <>
                  <span className="font-semibold text-ink">{`${row.rate}%`}</span>
                  <span className="text-ink-3">{` · ${row.agreed} of ${row.given}`}</span>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
