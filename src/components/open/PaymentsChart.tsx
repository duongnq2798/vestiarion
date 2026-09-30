import { scaleBand, scaleLinear } from "d3";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { utcDay } from "@/lib/copy";
import type { DailyPayments } from "@/lib/platform/open-numbers";
import { formatFigure } from "./OpenNumbersTable";

/**
 * Settled payments per UTC day, customers' stacked under ours (spec §2). A
 * server-rendered SVG: bars at most 24px wide with a 2px surface gap between
 * the two segments and a 4px rounded top, hairline gridlines, a legend, a
 * tooltip per day through <title> on a hit area as tall as the plot, and the
 * same figures as a table for anyone who cannot read the chart.
 *
 * The two hues passed the dataviz palette check on the light surface:
 * agent cobalt for customers, --color-series-ours for our workspaces.
 */

const WIDTH = 720;
const HEIGHT = 220;
const MARGIN = { top: 12, right: 8, bottom: 28, left: 36 };
const GAP = 2;
const RADIUS = 4;

const SERIES = [
  { key: "customers", label: "Customers", color: "var(--color-agent)" },
  { key: "ours", label: "Our workspaces", color: "var(--color-series-ours)" },
] as const;

const shortDay = (day: string) => utcDay(`${day}T00:00:00Z`).replace(/, \d{4}$/, "");
const fullDay = (day: string) => utcDay(`${day}T00:00:00Z`);

/** A bar segment with its top corners rounded and its base square. */
function topRounded(x: number, y: number, width: number, height: number): string {
  const r = Math.max(0, Math.min(RADIUS, width / 2, height));
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function dayTitle(row: DailyPayments): string {
  return `${fullDay(row.day)}: ${row.customers} by customers (${formatFigure(row.customersUsdc, "usdc")} USDC), ${row.ours} by our workspaces (${formatFigure(row.oursUsdc, "usdc")} USDC)`;
}

export function PaymentsChart({ series }: { series: DailyPayments[] }) {
  const customers = series.reduce((sum, row) => sum + row.customers, 0);
  const ours = series.reduce((sum, row) => sum + row.ours, 0);

  return (
    <section aria-labelledby="payments-by-day" className="mt-12">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="payments-by-day" className="text-xl font-semibold tracking-tight text-ink">
          Settled payments by day
        </h2>
        {series.length > 0 && (
          <ul className="flex flex-wrap gap-4 text-xs text-ink-2" aria-label="Legend">
            {SERIES.map((entry) => (
              <li key={entry.key} className="inline-flex items-center gap-2">
                <span aria-hidden className="size-2.5 rounded-full" style={{ background: entry.color }} />
                {entry.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      {series.length === 0 ? (
        <EmptyState compact className="mt-4" title="No payment settled in this period." body="Settled Arc testnet payments appear here by day." />
      ) : (
        <Chart series={series} customers={customers} ours={ours} />
      )}
    </section>
  );
}

function Chart({ series, customers, ours }: { series: DailyPayments[]; customers: number; ours: number }) {
  const x = scaleBand<string>()
    .domain(series.map((row) => row.day))
    .range([MARGIN.left, WIDTH - MARGIN.right]);
  const peak = Math.max(1, ...series.map((row) => row.customers + row.ours));
  const y = scaleLinear().domain([0, peak]).nice().range([HEIGHT - MARGIN.bottom, MARGIN.top]);
  const ticks = y.ticks(4).filter(Number.isInteger);
  const barWidth = Math.max(1, Math.min(24, x.bandwidth() - GAP));
  const baseline = y(0);
  const labelled = new Set([series[0].day, series[series.length - 1].day, series[Math.floor((series.length - 1) / 2)].day]);
  const summary = `${customers + ours} settled payments from ${fullDay(series[0].day)} to ${fullDay(series[series.length - 1].day)}: ${customers} by customers, ${ours} by our workspaces.`;

  return (
    <figure className="mt-4 rounded-2xl border border-line bg-surface p-4 shadow-surface">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={summary} className="h-auto w-full">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y(tick)} y2={y(tick)} stroke="var(--color-line)" strokeWidth="1" />
            <text x={MARGIN.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-ink-3 font-mono text-[10px]">
              {tick}
            </text>
          </g>
        ))}
        {series.map((row) => {
          const left = (x(row.day) ?? 0) + (x.bandwidth() - barWidth) / 2;
          const customerTop = y(row.customers);
          const oursTop = y(row.customers + row.ours);
          const customerHeight = baseline - customerTop;
          const oursHeight = customerTop - oursTop - (row.customers > 0 ? GAP : 0);
          return (
            <g key={row.day}>
              {row.customers > 0 &&
                (row.ours > 0 ? (
                  <rect x={left} y={customerTop} width={barWidth} height={customerHeight} fill={SERIES[0].color} />
                ) : (
                  <path d={topRounded(left, customerTop, barWidth, customerHeight)} fill={SERIES[0].color} />
                ))}
              {row.ours > 0 && oursHeight > 0 && <path d={topRounded(left, oursTop, barWidth, oursHeight)} fill={SERIES[1].color} />}
              <rect x={x(row.day)} y={MARGIN.top} width={x.bandwidth()} height={baseline - MARGIN.top} fill="transparent" className="hover:fill-ink/5">
                <title>{dayTitle(row)}</title>
              </rect>
              {labelled.has(row.day) && (
                <text x={(x(row.day) ?? 0) + x.bandwidth() / 2} y={HEIGHT - 8} textAnchor="middle" className="fill-ink-3 font-mono text-[10px]">
                  {shortDay(row.day)}
                </text>
              )}
            </g>
          );
        })}
        <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={baseline} y2={baseline} stroke="var(--color-line-strong)" strokeWidth="1" />
      </svg>
      <figcaption className="mt-2 text-xs text-ink-3">Days are UTC. Hover a day for its figures.</figcaption>
      <Disclosure variant="default" className="mt-4" summary="Show the days as a table">
        <Table label="Settled payments by day, as a table" className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead className="text-right">Customers</TableHead>
              <TableHead className="text-right">USDC</TableHead>
              <TableHead className="text-right">Our workspaces</TableHead>
              <TableHead className="text-right">USDC</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {series
              .filter((row) => row.customers + row.ours > 0)
              .map((row) => (
                <TableRow key={row.day}>
                  <TableCell className="font-mono">{fullDay(row.day)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{row.customers}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatFigure(row.customersUsdc, "usdc")}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{row.ours}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatFigure(row.oursUsdc, "usdc")}</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </Disclosure>
    </figure>
  );
}
