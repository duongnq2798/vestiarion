import type { ReactNode } from "react";
import { curveMonotoneX, line as d3Line, scaleBand, scaleLinear, scaleTime } from "d3";
import type {
  CycleRunTelemetry,
  CycleSnapshotTelemetry,
  InsightsData,
  ScreeningTelemetry,
  TransferTelemetry,
  TreasuryMoveTelemetry,
} from "@/lib/insights";
import { Card, fmt, Label } from "./Primitives";

const utc = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

function when(value: string): string {
  return `${utc.format(new Date(value))} UTC`;
}

function modeLabel(modes: Array<"live" | "simulate">): "LIVE" | "SIMULATED" | "MIXED" {
  const values = new Set(modes);
  if (values.size > 1) return "MIXED";
  return values.has("live") ? "LIVE" : "SIMULATED";
}

function Provenance({ modes, detail }: { modes: Array<"live" | "simulate">; detail: string }) {
  const label = modeLabel(modes);
  const live = label === "LIVE";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[0.6875rem] font-semibold tracking-[0.08em] ${live ? "border-proof-line bg-proof-soft text-proof" : "hatch border-dashed border-line-strong text-ink-2"}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${live ? "bg-proof" : "border border-ink-3"}`} />
      {detail} · {label}
    </span>
  );
}

function ChartCard({ title, description, provenance, children }: {
  title: string;
  description: string;
  provenance?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0 overflow-hidden p-5 sm:p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-2">{description}</p>
        </div>
        {provenance}
      </div>
      <div className="mt-6">{children}</div>
    </Card>
  );
}

function EmptyChart({ children }: { children: ReactNode }) {
  return <p className="hatch rounded-xl border border-dashed border-line-strong bg-ground/45 px-4 py-10 text-center text-sm text-ink-2">{children}</p>;
}

function DetailsTable({ summary, headers, rows }: {
  summary: string;
  headers: string[];
  rows: ReactNode[][];
}) {
  return (
    <details className="mt-4 border-t border-line pt-3">
      <summary className="cursor-pointer text-xs font-medium text-agent hover:underline">{summary}</summary>
      <div className="mt-3 max-w-full overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-left text-xs">
          <thead className="font-mono uppercase tracking-wide text-ink-3">
            <tr>{headers.map((header) => <th key={header} className="border-b border-line px-2 py-2 font-medium">{header}</th>)}</tr>
          </thead>
          <tbody className="text-ink-2">
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-line/60">
                {row.map((cell, cellIndex) => <td key={cellIndex} className="whitespace-nowrap px-2 py-2 tabular-nums">{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * Shows a dollar figure at the precision it was measured to. A chain fee on Arc
 * is a fraction of a cent, and USDC carries six decimals, so rounding to two
 * would turn every real reading into "$0.00" — a measured number displayed as
 * nothing is indistinguishable from no measurement at all.
 */
function usdLabel(value: number): string {
  if (value === 0) return "$0";
  const decimals = Math.abs(value) < 0.01 ? 6 : 2;
  return `$${value.toFixed(decimals)}`;
}

/**
 * How a cycle's agreement with the written policy should read in the table.
 *
 * A cycle that predates the comparison and a cycle where the model agreed on
 * everything are both "0 disagreements" if you let null collapse to zero, and
 * they mean opposite things: one was never measured, the other was measured and
 * passed. The distinction is the whole reason the column is nullable.
 */
/**
 * How a cycle ended. A run that fell over at the AP stage produced real counts
 * for the stages before it and none after, so reading its bar as a quiet cycle
 * would understate the book and hide the failure in the same glance.
 */
function cycleResult(run: CycleRunTelemetry): string {
  if (run.status === "running") return "still running";
  if (run.status === "failed") return `failed at ${run.failedStage ?? "an unnamed stage"}`;
  // A partial cycle ran to the end but did not do all of it. Its counts are
  // real and stop where the failure stopped them, so it is neither a clean run
  // nor a dead one, and flattening it into either would mislead.
  if (run.status === "partial") return `partial — ${run.failedStage ?? "a stage"} failed`;
  return "completed";
}

function policyDeparture(run: CycleRunTelemetry): string {
  if (run.referenceDisagreementCount == null) return "not compared";
  if (run.modelDecisionCount === 0) return "model not consulted";
  return `${run.referenceDisagreementCount} of ${run.modelDecisionCount}`;
}

function MetricPlot({ values, label, unit, color, valueLabel }: {
  values: number[];
  label: string;
  unit: string;
  color: string;
  valueLabel: (value: number) => string;
}) {
  if (values.length === 0) {
    return <div className="flex min-h-40 items-center justify-center rounded-md border border-dashed border-line text-center text-xs text-ink-3">No confirmed measurement</div>;
  }
  const width = 360;
  const height = 150;
  const right = 12;
  const top = 20;
  const bottom = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Pad relative to the data, never by a fixed amount. This floor used to be
  // `1`, which is a whole dollar — so a real fee series sitting at $0.0032 was
  // plotted on an axis running -$1.00 to $2.00 and rendered as a flat line at
  // zero. The measurement was right and the frame hid it.
  const padding = min === max ? Math.max(Math.abs(min) * 0.12, Number.MIN_VALUE) : 0;
  const y = scaleLinear()
    .domain([Math.min(0, min - padding), max + padding])
    .nice(3)
    .range([height - bottom, top]);
  const ticks = y.ticks(3);
  // The gutter has to fit the labels the data actually produces. A fee reading
  // to six decimals is a much wider string than "$2.00", and a fixed 38px
  // gutter clipped the first character off every tick.
  const left = Math.min(
    96,
    Math.max(38, ...ticks.map((tick) => valueLabel(tick).length * 5.2 + 9))
  );
  const x = scaleLinear()
    .domain([0, Math.max(values.length - 1, 1)])
    .range([left, width - right]);
  const path = values.length > 1
    ? d3Line<number>().x((_value, index) => x(index)).y((value) => y(value)).curve(curveMonotoneX)(values)
    : null;
  return (
    <div className="min-w-0 rounded-xl border border-line bg-ground/35 p-3">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <Label>{label}</Label>
        <span className="font-mono text-[0.6875rem] text-ink-3">{unit}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-1 h-auto w-full" role="img" aria-label={`${label}: ${values.length} observed point${values.length === 1 ? "" : "s"}, from ${valueLabel(min)} to ${valueLabel(max)}`}>
        <defs>
          <linearGradient id={`${label.replaceAll(" ", "-")}-wash`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.16" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => <g key={tick}>
          <line x1={left} y1={y(tick)} x2={width - right} y2={y(tick)} stroke="var(--color-line)" strokeDasharray="2 5" />
          <text x={left - 5} y={y(tick) + 3} textAnchor="end" fill="var(--color-ink-3)" fontSize="9">{valueLabel(tick)}</text>
        </g>)}
        {path && <>
          <path d={`${path} L ${x(values.length - 1)},${height - bottom} L ${x(0)},${height - bottom} Z`} fill={`url(#${label.replaceAll(" ", "-")}-wash)`} />
          <path d={path} fill="none" stroke={color} strokeWidth="2.25" vectorEffect="non-scaling-stroke" />
        </>}
        {values.map((value, index) => <circle key={index} cx={x(values.length === 1 ? 0.5 : index)} cy={y(value)} r="3.5" fill="var(--color-surface)" stroke={color} strokeWidth="2"><title>{valueLabel(value)}</title></circle>)}
        {values.length === 1 ? (
          <text x={width / 2} y={height - 8} textAnchor="middle" fill="var(--color-ink-3)" fontSize="10">only observation</text>
        ) : (
          <>
            <text x={left} y={height - 8} fill="var(--color-ink-3)" fontSize="10">first</text>
            <text x={width - right} y={height - 8} textAnchor="end" fill="var(--color-ink-3)" fontSize="10">latest</text>
          </>
        )}
      </svg>
    </div>
  );
}

function TransferChart({ transfers }: { transfers: TransferTelemetry[] }) {
  if (transfers.length === 0) {
    return (
      <ChartCard title="Settlement cost and speed" description="Fee and confirmation latency captured at the payment boundary, never reconstructed later.">
        <EmptyChart>No measured transfers recorded yet — run an agent cycle to populate this.</EmptyChart>
      </ChartCard>
    );
  }
  const settled = transfers.filter((transfer) => transfer.settledInMs != null);
  return (
    <ChartCard
      title="Settlement cost and speed"
      description="Each point is one executed transfer. Fee provenance distinguishes a chain report from a provider estimate or simulated profile."
      provenance={<Provenance modes={transfers.map((transfer) => transfer.providerMode)} detail="Transfers" />}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {/* Arc fees land around $0.003, so two decimal places would print
            every real reading — and every axis tick — as "$0.00". */}
        <MetricPlot values={transfers.map((transfer) => transfer.feeUsd)} label="Transfer fee" unit="USD" color="var(--color-proof)" valueLabel={usdLabel} />
        <MetricPlot values={settled.map((transfer) => transfer.settledInMs as number)} label="Settlement time" unit="milliseconds" color="var(--color-agent)" valueLabel={(value) => `${Math.round(value)}ms`} />
      </div>
      <DetailsTable
        summary="Transfer receipt table"
        headers={["Executed", "Target", "Mode", "Fee", "Fee source", "Settlement", "Transaction"]}
        rows={transfers.map((transfer) => [
          when(transfer.executedAt),
          transfer.targetType,
          transfer.providerMode === "live" ? "LIVE" : "SIMULATED",
          usdLabel(transfer.feeUsd),
          transfer.feeSource.replaceAll("_", " "),
          transfer.settledInMs == null ? "pending / unavailable" : `${Math.round(transfer.settledInMs)} ms`,
          <span key={transfer.id} title={transfer.txRef}>{transfer.txRef.slice(0, 12)}…</span>,
        ])}
      />
    </ChartCard>
  );
}

function BalanceChart({ snapshots, moves }: { snapshots: CycleSnapshotTelemetry[]; moves: TreasuryMoveTelemetry[] }) {
  if (snapshots.length === 0) {
    return (
      <ChartCard title="Treasury balance over time" description="Liquid and reserve positions captured after each completed cycle.">
        <EmptyChart>No cycles recorded yet — run an agent cycle to populate this.</EmptyChart>
      </ChartCard>
    );
  }
  const width = 760;
  const height = 250;
  const left = 54;
  const right = 18;
  const top = 28;
  const bottom = 38;
  const values = snapshots.flatMap((snapshot) => [snapshot.totalLiquid, snapshot.reservePosition]);
  const max = Math.max(...values, 1);
  const minTime = Date.parse(snapshots[0].capturedAt);
  const maxTime = Date.parse(snapshots.at(-1)?.capturedAt ?? snapshots[0].capturedAt);
  const halfDay = 43_200_000;
  const xTime = scaleTime()
    .domain(minTime === maxTime ? [new Date(minTime - halfDay), new Date(maxTime + halfDay)] : [new Date(minTime), new Date(maxTime)])
    .range([left, width - right]);
  const y = scaleLinear().domain([0, max]).nice(4).range([height - bottom, top]);
  const liquidPath = d3Line<CycleSnapshotTelemetry>()
    .x((snapshot) => xTime(new Date(snapshot.capturedAt)))
    .y((snapshot) => y(snapshot.totalLiquid))
    .curve(curveMonotoneX)(snapshots);
  const reservePath = d3Line<CycleSnapshotTelemetry>()
    .x((snapshot) => xTime(new Date(snapshot.capturedAt)))
    .y((snapshot) => y(snapshot.reservePosition))
    .curve(curveMonotoneX)(snapshots);
  const yTicks = y.ticks(4);
  const relevantMoves = moves.filter((move) => Date.parse(move.createdAt) >= minTime && Date.parse(move.createdAt) <= maxTime);
  return (
    <ChartCard
      title="Treasury balance over time"
      description="Post-cycle liquid and reserve positions. S marks a recorded sweep; R marks a recorded redemption within the plotted interval."
      provenance={<Provenance modes={snapshots.map((snapshot) => snapshot.chainMode)} detail="Balances" />}
    >
      <div className="flex flex-wrap gap-4 text-xs text-ink-2" aria-hidden>
        <span><span className="mr-1.5 inline-block h-0.5 w-5 bg-agent align-middle" />Liquid</span>
        <span><span className="mr-1.5 inline-block h-0.5 w-5 bg-proof align-middle" />Reserve</span>
        <span><span className="mr-1.5 text-held">◆</span>Treasury move</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-3 h-auto w-full rounded-xl bg-ground/35 p-1" role="img" aria-label={`${snapshots.length} balance snapshots; latest liquid balance ${fmt(snapshots.at(-1)?.totalLiquid ?? 0)} USDC and reserve ${fmt(snapshots.at(-1)?.reservePosition ?? 0)} USYC`}>
        {yTicks.map((tick) => <g key={tick}>
          <line x1={left} y1={y(tick)} x2={width - right} y2={y(tick)} stroke="var(--color-line)" strokeDasharray="2 6" />
          <text x={left - 7} y={y(tick) + 4} textAnchor="end" fill="var(--color-ink-3)" fontSize="10">{fmt(tick)}</text>
        </g>)}
        <text x="13" y={(top + height - bottom) / 2} textAnchor="middle" fill="var(--color-ink-3)" fontSize="10" transform={`rotate(-90 13 ${(top + height - bottom) / 2})`}>token units</text>
        {snapshots.length > 1 && <>
          {liquidPath && <path d={liquidPath} fill="none" stroke="var(--color-agent)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />}
          {reservePath && <path d={reservePath} fill="none" stroke="var(--color-proof)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />}
        </>}
        {snapshots.map((snapshot) => <g key={snapshot.id}>
          <circle cx={xTime(new Date(snapshot.capturedAt))} cy={y(snapshot.totalLiquid)} r="3.5" fill="var(--color-surface)" stroke="var(--color-agent)" strokeWidth="2" />
          <circle cx={xTime(new Date(snapshot.capturedAt))} cy={y(snapshot.reservePosition)} r="3.5" fill="var(--color-surface)" stroke="var(--color-proof)" strokeWidth="2" />
        </g>)}
        {relevantMoves.map((move) => <g key={move.id}>
          <line x1={xTime(new Date(move.createdAt))} y1={top} x2={xTime(new Date(move.createdAt))} y2={height - bottom} stroke="var(--color-held)" strokeDasharray="3 4" opacity="0.7" />
          <text x={xTime(new Date(move.createdAt))} y={top - 7} textAnchor="middle" fill="var(--color-held)" fontSize="11">{move.action === "sweep_to_usyc" ? "S" : move.action === "redeem_from_usyc" ? "R" : "B"}</text>
        </g>)}
        <text x={left} y={height - 12} fill="var(--color-ink-3)" fontSize="10">{when(snapshots[0].capturedAt)}</text>
        <text x={width - right} y={height - 12} textAnchor="end" fill="var(--color-ink-3)" fontSize="10">{when(snapshots.at(-1)?.capturedAt ?? snapshots[0].capturedAt)}</text>
      </svg>
      <DetailsTable
        summary="Balance snapshot table"
        headers={["Captured", "Mode", "Liquid", "Reserve", "Open AP", "Open AR", "Due 7d", "Due 14d"]}
        rows={snapshots.map((snapshot) => [when(snapshot.capturedAt), snapshot.chainMode === "live" ? "LIVE" : "SIMULATED", fmt(snapshot.totalLiquid), fmt(snapshot.reservePosition), fmt(snapshot.openPayables), fmt(snapshot.openReceivables), fmt(snapshot.obligationsDue7d), fmt(snapshot.obligationsDue14d)])}
      />
    </ChartCard>
  );
}

type OutcomeKey = "paid" | "held" | "flagged" | "awaiting" | "released";
const outcomes: Array<{ key: OutcomeKey; label: string; color: string; value: (run: CycleRunTelemetry) => number }> = [
  { key: "paid", label: "Paid", color: "var(--color-proof)", value: (run) => run.paidCount },
  { key: "released", label: "Released", color: "var(--color-agent)", value: (run) => run.releasedCount },
  { key: "held", label: "Held", color: "var(--color-held)", value: (run) => run.heldCount },
  { key: "flagged", label: "Flagged", color: "var(--color-refused)", value: (run) => run.flaggedCount },
  { key: "awaiting", label: "Awaiting info", color: "var(--color-ink-3)", value: (run) => run.awaitingInfoCount },
];

function OutcomeChart({ runs }: { runs: CycleRunTelemetry[] }) {
  if (runs.length === 0) {
    return <ChartCard title="Decision outcomes per cycle" description="Executed and refused outcomes counted where each decision occurs."><EmptyChart>No cycles recorded yet — run an agent cycle to populate this.</EmptyChart></ChartCard>;
  }
  const totals = runs.map((run) => outcomes.reduce((sum, outcome) => sum + outcome.value(run), 0));
  const width = scaleLinear().domain([0, Math.max(...totals, 1)]).range([0, 100]);
  return (
    <ChartCard title="Decision outcomes per cycle" description="Each horizontal bar is one cycle; segments are observed outcomes, not a fitted trend. A cycle that failed partway is marked as such, because its counts are real but stop where it stopped." provenance={<Provenance modes={runs.map((run) => run.chainMode)} detail="Cycles" />}>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-ink-2">
        {outcomes.map((outcome) => <span key={outcome.key}><span className="mr-1.5 inline-block size-2 rounded-sm" style={{ background: outcome.color }} />{outcome.label}</span>)}
      </div>
      <ol className="mt-4 space-y-3">
        {runs.map((run, index) => {
          const total = totals[index];
          return <li key={run.id} className="grid grid-cols-[3.5rem_minmax(0,1fr)_2rem] items-center gap-2 text-xs">
            <span className="font-mono text-ink-3">#{index + 1}</span>
            <div className="flex h-5 min-w-0 overflow-hidden rounded-sm bg-raised" aria-label={`${total} outcomes`}>
              {total === 0 ? <span className={`m-auto text-[0.625rem] ${run.status === "failed" || run.status === "partial" ? "text-refusal" : "text-ink-3"}`}>{run.status === "failed" || run.status === "partial" ? `${run.status} — ${run.failedStage ?? "a stage"} failed` : run.status === "running" ? "still running" : "no outcomes"}</span> : outcomes.map((outcome) => {
                const value = outcome.value(run);
                return value > 0 ? <span key={outcome.key} title={`${outcome.label}: ${value}`} style={{ width: `${width(value)}%`, background: outcome.color }} /> : null;
              })}
            </div>
            <span className="text-right tabular-nums text-ink-2">{total}{(run.status === "failed" || run.status === "partial") && total > 0 && <span className="ml-1 text-refusal" title={`Partial: the cycle failed at ${run.failedStage ?? "an unnamed stage"}`}>&#9670;</span>}</span>
          </li>;
        })}
      </ol>
      <DetailsTable summary="Decision outcome table" headers={["Finished", "Result", "Paid", "Released", "Held", "Flagged", "Awaiting", "Guardrail overrides"]} rows={runs.map((run) => [when(run.finishedAt), cycleResult(run), run.paidCount, run.releasedCount, run.heldCount, run.flaggedCount, run.awaitingInfoCount, run.guardrailOverrideCount])} />
    </ChartCard>
  );
}

function DecisionModeChart({ runs }: { runs: CycleRunTelemetry[] }) {
  if (runs.length === 0) {
    return <ChartCard title="Model vs heuristic" description="Which decision engine actually returned each verdict."><EmptyChart>No cycles recorded yet — run an agent cycle to populate this.</EmptyChart></ChartCard>;
  }
  const totals = runs.map((run) => run.modelDecisionCount + run.heuristicDecisionCount);
  const width = scaleLinear().domain([0, Math.max(...totals, 1)]).range([0, 100]);
  return (
    <ChartCard title="Model vs heuristic" description="The model share and rule-based fallback are persisted by the orchestrator, including cycles where one side is zero. Where the model was consulted, its verdict is scored against the same written policy the fallback applies." provenance={<Provenance modes={runs.map((run) => run.chainMode)} detail="Cycles" />}>
      <div className="flex gap-4 text-xs text-ink-2"><span><span className="mr-1.5 inline-block size-2 bg-agent" />Model</span><span><span className="mr-1.5 inline-block size-2 bg-line-strong" />Heuristic</span><span className="text-refusal">&#9670; Departed from policy</span></div>
      <ol className="mt-4 space-y-3">
        {runs.map((run, index) => {
          const total = totals[index];
          return <li key={run.id} className="grid grid-cols-[3.5rem_minmax(0,1fr)_3.5rem] items-center gap-2 text-xs">
            <span className="font-mono text-ink-3">#{index + 1}</span>
            <div className="flex h-5 min-w-0 overflow-hidden rounded-sm bg-raised">
              {total === 0 ? <span className="m-auto text-[0.625rem] text-ink-3">no decisions</span> : <>
                {run.modelDecisionCount > 0 && <span title={`Model: ${run.modelDecisionCount}`} className="bg-agent" style={{ width: `${width(run.modelDecisionCount)}%` }} />}
                {run.heuristicDecisionCount > 0 && <span title={`Heuristic: ${run.heuristicDecisionCount}`} className="bg-line-strong" style={{ width: `${width(run.heuristicDecisionCount)}%` }} />}
              </>}
            </div>
            <span className="text-right tabular-nums text-ink-2">
              {run.modelDecisionCount}/{total}
              {run.referenceDisagreementCount != null && run.referenceDisagreementCount > 0 && (
                <span className="ml-1 text-refusal" title={`${run.referenceDisagreementCount} model verdict(s) departed from the written policy`}>&#9670;{run.referenceDisagreementCount}</span>
              )}
            </span>
          </li>;
        })}
      </ol>
      <DetailsTable summary="Decision mode table" headers={["Finished", "Model", "Heuristic", "Departed from policy", "Total", "Duration"]} rows={runs.map((run) => [when(run.finishedAt), run.modelDecisionCount, run.heuristicDecisionCount, policyDeparture(run), run.decisionCount, `${run.durationMs} ms`])} />
    </ChartCard>
  );
}

interface ScreeningBatch {
  at: string;
  rows: ScreeningTelemetry[];
}

function screeningBatches(rows: ScreeningTelemetry[]): ScreeningBatch[] {
  const batches: ScreeningBatch[] = [];
  for (const row of rows) {
    const previous = batches.at(-1);
    if (!previous || Date.parse(row.createdAt) - Date.parse(previous.rows.at(-1)?.createdAt ?? previous.at) > 120_000) {
      batches.push({ at: row.createdAt, rows: [row] });
    } else {
      previous.rows.push(row);
    }
  }
  return batches;
}

function ScreeningChart({ screenings }: { screenings: ScreeningTelemetry[] }) {
  if (screenings.length === 0) {
    return <ChartCard title="Screening coverage" description="Completed and failed counterparty checks, with observed tier transitions."><EmptyChart>No screening checks recorded yet — run an agent cycle to populate this.</EmptyChart></ChartCard>;
  }
  const batches = screeningBatches(screenings);
  const max = Math.max(...batches.map((batch) => batch.rows.length));
  const width = 760;
  const height = Math.max(180, batches.length * 48 + 62);
  const left = 105;
  const right = 76;
  const top = 22;
  const bottom = 30;
  const keys = batches.map((batch, index) => `${batch.at}-${index}`);
  const x = scaleLinear().domain([0, max]).nice().range([left, width - right]);
  const y = scaleBand().domain(keys).range([top, height - bottom]).padding(0.34);
  const ticks = x.ticks(Math.min(max, 5));
  return (
    <ChartCard title="Screening coverage" description="Consecutive checks within two minutes are displayed as one observed batch. A red segment is a failed lookup; the previous verdict stayed in force." provenance={<Provenance modes={screenings.map((row) => row.mode)} detail="Screening" />}>
      <div className="mt-1 flex flex-wrap gap-4 text-xs text-ink-2" aria-hidden>
        <span><span className="mr-1.5 inline-block size-2 rounded-sm bg-proof" />Completed</span>
        <span><span className="mr-1.5 inline-block size-2 rounded-sm bg-refused" />Failed lookup</span>
        <span><span className="mr-1.5 text-held">◆</span>Tier change</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-3 h-auto w-full rounded-xl bg-ground/35 p-1" role="img" aria-label={`${screenings.length} screening checks in ${batches.length} observed batches`}>
        {ticks.map((tick) => <g key={tick}>
          <line x1={x(tick)} y1={top} x2={x(tick)} y2={height - bottom} stroke="var(--color-line)" strokeDasharray="2 6" />
          <text x={x(tick)} y={height - 10} textAnchor="middle" fill="var(--color-ink-3)" fontSize="10">{tick}</text>
        </g>)}
        {batches.map((batch, index) => {
          const changes = batch.rows.filter((row) => row.tierChanged).length;
          const failures = batch.rows.filter((row) => row.status === "failed").length;
          const key = keys[index];
          const barY = y(key) ?? 0;
          const complete = batch.rows.length - failures;
          return <g key={key}>
            <text x={left - 10} y={barY + y.bandwidth() / 2 + 4} textAnchor="end" fill="var(--color-ink-3)" fontSize="10">{when(batch.at).replace(" UTC", "")}</text>
            <rect x={left} y={barY} width={width - left - right} height={y.bandwidth()} rx="5" fill="var(--color-raised)" />
            {complete > 0 && <rect x={left} y={barY} width={x(complete) - left} height={y.bandwidth()} rx="5" fill="var(--color-proof)" opacity="0.88" />}
            {failures > 0 && <rect x={x(complete)} y={barY} width={x(batch.rows.length) - x(complete)} height={y.bandwidth()} rx="3" fill="var(--color-refused)" />}
            {changes > 0 && <path d={`M ${x(batch.rows.length) + 9} ${barY + y.bandwidth() / 2 - 5} l 5 5 -5 5 -5 -5 Z`} fill="var(--color-held)" />}
            <text x={width - right + 10} y={barY + y.bandwidth() / 2 + 4} fill="var(--color-ink-2)" fontSize="10">{batch.rows.length} check{batch.rows.length === 1 ? "" : "s"}</text>
          </g>;
        })}
      </svg>
      <DetailsTable summary="Screening receipt table" headers={["Checked", "Counterparty", "Mode", "Result", "Transition", "Source"]} rows={screenings.map((row) => [when(row.createdAt), row.counterpartyName, row.mode === "live" ? "LIVE" : "SIMULATED", row.status === "failed" ? "failed — retained" : row.riskLevel, row.tierChanged ? `${row.previousRiskLevel} → ${row.riskLevel}` : "none observed", row.source])} />
    </ChartCard>
  );
}

export function InsightsCharts({ data }: { data: InsightsData }) {
  return (
    <div className="space-y-5">
      <TransferChart transfers={data.transfers} />
      <BalanceChart snapshots={data.snapshots} moves={data.treasuryMoves} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <OutcomeChart runs={data.runs} />
        <DecisionModeChart runs={data.runs} />
      </div>
      <ScreeningChart screenings={data.screenings} />
    </div>
  );
}
