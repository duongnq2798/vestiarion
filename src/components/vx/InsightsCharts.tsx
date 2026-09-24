import type { ReactNode } from "react";
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
    <Card className="min-w-0 p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-semibold text-ink">{title}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-2">{description}</p>
        </div>
        {provenance}
      </div>
      <div className="mt-5">{children}</div>
    </Card>
  );
}

function EmptyChart({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-line-strong px-4 py-8 text-center text-sm text-ink-2">{children}</p>;
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
  const left = 38;
  const right = 12;
  const top = 20;
  const bottom = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const x = (index: number) => values.length === 1 ? (left + width - right) / 2 : left + index * ((width - left - right) / (values.length - 1));
  const y = (value: number) => range === 0 ? (top + height - bottom) / 2 : top + (max - value) * ((height - top - bottom) / range);
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  return (
    <div className="min-w-0 rounded-md border border-line bg-ground/40 p-2">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <Label>{label}</Label>
        <span className="font-mono text-[0.6875rem] text-ink-3">{unit}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-1 h-auto w-full" role="img" aria-label={`${label}: ${values.length} observed point${values.length === 1 ? "" : "s"}, from ${valueLabel(min)} to ${valueLabel(max)}`}>
        <line x1={left} y1={top} x2={left} y2={height - bottom} stroke="var(--color-line-strong)" />
        <line x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} stroke="var(--color-line-strong)" />
        <text x={left - 5} y={top + 3} textAnchor="end" fill="var(--color-ink-3)" fontSize="10">{valueLabel(max)}</text>
        <text x={left - 5} y={height - bottom + 3} textAnchor="end" fill="var(--color-ink-3)" fontSize="10">{valueLabel(min)}</text>
        {values.length > 1 && <polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
        {values.map((value, index) => <circle key={index} cx={x(index)} cy={y(value)} r="3" fill={color}><title>{valueLabel(value)}</title></circle>)}
        <text x={left} y={height - 8} fill="var(--color-ink-3)" fontSize="10">first</text>
        <text x={width - right} y={height - 8} textAnchor="end" fill="var(--color-ink-3)" fontSize="10">latest</text>
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
        <MetricPlot values={transfers.map((transfer) => transfer.feeUsd)} label="Transfer fee" unit="USD" color="var(--color-proof)" valueLabel={(value) => `$${fmt(value)}`} />
        <MetricPlot values={settled.map((transfer) => transfer.settledInMs as number)} label="Settlement time" unit="milliseconds" color="var(--color-agent)" valueLabel={(value) => `${Math.round(value)}ms`} />
      </div>
      <DetailsTable
        summary="Transfer receipt table"
        headers={["Executed", "Target", "Mode", "Fee", "Fee source", "Settlement", "Transaction"]}
        rows={transfers.map((transfer) => [
          when(transfer.executedAt),
          transfer.targetType,
          transfer.providerMode === "live" ? "LIVE" : "SIMULATED",
          `$${fmt(transfer.feeUsd)}`,
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
  const xTime = (date: string) => minTime === maxTime ? (left + width - right) / 2 : left + (Date.parse(date) - minTime) * ((width - left - right) / (maxTime - minTime));
  const y = (value: number) => top + (max - value) * ((height - top - bottom) / max);
  const points = (selector: (snapshot: CycleSnapshotTelemetry) => number) => snapshots.map((snapshot) => `${xTime(snapshot.capturedAt)},${y(selector(snapshot))}`).join(" ");
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
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 h-auto w-full" role="img" aria-label={`${snapshots.length} balance snapshots; latest liquid balance ${fmt(snapshots.at(-1)?.totalLiquid ?? 0)} USDC and reserve ${fmt(snapshots.at(-1)?.reservePosition ?? 0)} USYC`}>
        <line x1={left} y1={top} x2={left} y2={height - bottom} stroke="var(--color-line-strong)" />
        <line x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} stroke="var(--color-line-strong)" />
        <text x={left - 7} y={top + 4} textAnchor="end" fill="var(--color-ink-3)" fontSize="11">{fmt(max)}</text>
        <text x={left - 7} y={height - bottom + 4} textAnchor="end" fill="var(--color-ink-3)" fontSize="11">0</text>
        <text x="13" y={(top + height - bottom) / 2} textAnchor="middle" fill="var(--color-ink-3)" fontSize="10" transform={`rotate(-90 13 ${(top + height - bottom) / 2})`}>token units</text>
        {snapshots.length > 1 && <>
          <polyline points={points((snapshot) => snapshot.totalLiquid)} fill="none" stroke="var(--color-agent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          <polyline points={points((snapshot) => snapshot.reservePosition)} fill="none" stroke="var(--color-proof)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </>}
        {snapshots.map((snapshot) => <g key={snapshot.id}>
          <circle cx={xTime(snapshot.capturedAt)} cy={y(snapshot.totalLiquid)} r="3" fill="var(--color-agent)" />
          <circle cx={xTime(snapshot.capturedAt)} cy={y(snapshot.reservePosition)} r="3" fill="var(--color-proof)" />
        </g>)}
        {relevantMoves.map((move) => <g key={move.id}>
          <line x1={xTime(move.createdAt)} y1={top} x2={xTime(move.createdAt)} y2={height - bottom} stroke="var(--color-held)" strokeDasharray="3 4" opacity="0.7" />
          <text x={xTime(move.createdAt)} y={top - 7} textAnchor="middle" fill="var(--color-held)" fontSize="11">{move.action === "sweep_to_usyc" ? "S" : move.action === "redeem_from_usyc" ? "R" : "B"}</text>
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
  return (
    <ChartCard title="Decision outcomes per cycle" description="Each horizontal bar is one completed cycle; segments are observed outcomes, not a fitted trend." provenance={<Provenance modes={runs.map((run) => run.chainMode)} detail="Cycles" />}>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-ink-2">
        {outcomes.map((outcome) => <span key={outcome.key}><span className="mr-1.5 inline-block size-2 rounded-sm" style={{ background: outcome.color }} />{outcome.label}</span>)}
      </div>
      <ol className="mt-4 space-y-3">
        {runs.map((run, index) => {
          const total = outcomes.reduce((sum, outcome) => sum + outcome.value(run), 0);
          return <li key={run.id} className="grid grid-cols-[3.5rem_minmax(0,1fr)_2rem] items-center gap-2 text-xs">
            <span className="font-mono text-ink-3">#{index + 1}</span>
            <div className="flex h-5 min-w-0 overflow-hidden rounded-sm bg-raised" aria-label={`${total} outcomes`}>
              {total === 0 ? <span className="m-auto text-[0.625rem] text-ink-3">no outcomes</span> : outcomes.map((outcome) => {
                const value = outcome.value(run);
                return value > 0 ? <span key={outcome.key} title={`${outcome.label}: ${value}`} style={{ width: `${(value / total) * 100}%`, background: outcome.color }} /> : null;
              })}
            </div>
            <span className="text-right tabular-nums text-ink-2">{total}</span>
          </li>;
        })}
      </ol>
      <DetailsTable summary="Decision outcome table" headers={["Finished", "Paid", "Released", "Held", "Flagged", "Awaiting", "Guardrail overrides"]} rows={runs.map((run) => [when(run.finishedAt), run.paidCount, run.releasedCount, run.heldCount, run.flaggedCount, run.awaitingInfoCount, run.guardrailOverrideCount])} />
    </ChartCard>
  );
}

function DecisionModeChart({ runs }: { runs: CycleRunTelemetry[] }) {
  if (runs.length === 0) {
    return <ChartCard title="Model vs heuristic" description="Which decision engine actually returned each verdict."><EmptyChart>No cycles recorded yet — run an agent cycle to populate this.</EmptyChart></ChartCard>;
  }
  return (
    <ChartCard title="Model vs heuristic" description="The model share and rule-based fallback are persisted by the orchestrator, including cycles where one side is zero." provenance={<Provenance modes={runs.map((run) => run.chainMode)} detail="Cycles" />}>
      <div className="flex gap-4 text-xs text-ink-2"><span><span className="mr-1.5 inline-block size-2 bg-agent" />Model</span><span><span className="mr-1.5 inline-block size-2 bg-line-strong" />Heuristic</span></div>
      <ol className="mt-4 space-y-3">
        {runs.map((run, index) => {
          const total = run.modelDecisionCount + run.heuristicDecisionCount;
          return <li key={run.id} className="grid grid-cols-[3.5rem_minmax(0,1fr)_3.5rem] items-center gap-2 text-xs">
            <span className="font-mono text-ink-3">#{index + 1}</span>
            <div className="flex h-5 min-w-0 overflow-hidden rounded-sm bg-raised">
              {total === 0 ? <span className="m-auto text-[0.625rem] text-ink-3">no decisions</span> : <>
                {run.modelDecisionCount > 0 && <span title={`Model: ${run.modelDecisionCount}`} className="bg-agent" style={{ width: `${(run.modelDecisionCount / total) * 100}%` }} />}
                {run.heuristicDecisionCount > 0 && <span title={`Heuristic: ${run.heuristicDecisionCount}`} className="bg-line-strong" style={{ width: `${(run.heuristicDecisionCount / total) * 100}%` }} />}
              </>}
            </div>
            <span className="text-right tabular-nums text-ink-2">{run.modelDecisionCount}/{total}</span>
          </li>;
        })}
      </ol>
      <DetailsTable summary="Decision mode table" headers={["Finished", "Model", "Heuristic", "Total", "Duration"]} rows={runs.map((run) => [when(run.finishedAt), run.modelDecisionCount, run.heuristicDecisionCount, run.decisionCount, `${run.durationMs} ms`])} />
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
  return (
    <ChartCard title="Screening coverage" description="Consecutive checks within two minutes are displayed as one observed batch. A red marker is a failed lookup; the previous verdict stayed in force." provenance={<Provenance modes={screenings.map((row) => row.mode)} detail="Screening" />}>
      <ol className="space-y-3">
        {batches.map((batch, index) => {
          const changes = batch.rows.filter((row) => row.tierChanged).length;
          const failures = batch.rows.filter((row) => row.status === "failed").length;
          return <li key={`${batch.at}-${index}`} className="grid grid-cols-[5rem_minmax(0,1fr)_4.5rem] items-center gap-2 text-xs">
            <span className="font-mono text-ink-3">{when(batch.at).replace(" UTC", "")}</span>
            <div className="h-5 min-w-0 overflow-hidden rounded-sm bg-raised">
              <div className="flex h-full" style={{ width: `${(batch.rows.length / max) * 100}%` }}>
                {batch.rows.length - failures > 0 && <span className="h-full bg-proof" style={{ width: `${((batch.rows.length - failures) / batch.rows.length) * 100}%` }} />}
                {failures > 0 && <span className="h-full bg-refused" style={{ width: `${(failures / batch.rows.length) * 100}%` }} />}
              </div>
            </div>
            <span className="text-right tabular-nums text-ink-2">{batch.rows.length} check{batch.rows.length === 1 ? "" : "s"}{changes > 0 ? ` · ${changes} Δ` : ""}{failures > 0 ? ` · ${failures} !` : ""}</span>
          </li>;
        })}
      </ol>
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
