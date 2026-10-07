import { Table, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import type { OpenNumbers, Period, SideKey, SideNumbers } from "@/lib/platform/open-numbers";

/**
 * Every open figure in one table (spec §2), grouped by what it says: adoption,
 * money moved, the agent's work, how its decisions turned out, and the
 * controls around it. One column each for customers' workspaces, ours and the
 * total; customers' is the one set in ink, since it answers "who uses this".
 * A `now` row is a total at the moment of reading; every other row covers the
 * chosen period. The outcomes come from docs/superpowers/specs/2026-10-01-open-outcomes-design.md.
 */
type Format = "count" | "usdc" | "duration" | "percent" | "ratio";

type FigureKey = keyof SideNumbers;

export interface OpenRow {
  key: FigureKey;
  label: string;
  kind: "period" | "now";
  format: Format;
  /** For `percent` and `ratio`: the figures whose sum is the whole that `key` is part of. */
  of?: readonly FigureKey[];
}

export interface FigureGroup {
  id: string;
  title: string;
  rows: ReadonlyArray<OpenRow>;
}

/** The share of payment decisions the agent carried out itself; the rest it escalated to a person. */
export const DECIDED_BY_AGENT: OpenRow = {
  key: "decisionsCarriedOut",
  label: "Decided by the agent itself",
  kind: "period",
  format: "percent",
  of: ["decisionsCarriedOut", "decisionsEscalated"],
};

export const FIGURE_GROUPS: ReadonlyArray<FigureGroup> = [
  {
    id: "adoption",
    title: "Adoption",
    rows: [
      { key: "workspacesOpened", label: "Workspaces opened", kind: "period", format: "count" },
      { key: "liveWorkspaces", label: "Workspaces live", kind: "now", format: "count" },
      { key: "people", label: "People in workspaces", kind: "now", format: "count" },
      { key: "firstPayments", label: "Workspaces that made a first payment", kind: "period", format: "count" },
      { key: "medianMinutesToFirstPayment", label: "Median time from workspace opened to first payment", kind: "period", format: "duration" },
    ],
  },
  {
    id: "money",
    title: "Money moved",
    rows: [
      { key: "payments", label: "Payments settled", kind: "period", format: "count" },
      { key: "usdcPaid", label: "USDC paid", kind: "period", format: "usdc" },
      { key: "payees", label: "Payee wallets paid", kind: "period", format: "count" },
      { key: "milestonesReleased", label: "Contractor milestones paid", kind: "period", format: "count" },
      { key: "usdcInWallets", label: "USDC in wallets", kind: "now", format: "usdc" },
    ],
  },
  {
    id: "agent",
    title: "Agent activity",
    rows: [
      { key: "cycles", label: "Agent cycles run", kind: "period", format: "count" },
      { key: "modelDecisions", label: "Decisions made by a model", kind: "period", format: "count" },
      { key: "invoicesDecided", label: "Invoices decided", kind: "period", format: "count" },
      { key: "decisionsCarriedOut", label: "Payment decisions the agent carried out itself", kind: "period", format: "count" },
      { key: "decisionsEscalated", label: "Payment decisions it escalated to a person", kind: "period", format: "count" },
      DECIDED_BY_AGENT,
      { key: "escalationsResolved", label: "Escalations a person resolved", kind: "period", format: "count" },
    ],
  },
  {
    id: "outcomes",
    title: "Outcomes",
    rows: [
      { key: "invoicesPaidOnTime", label: "Invoices paid on time", kind: "period", format: "ratio", of: ["invoicesPaidOnArc"] },
      {
        key: "invoicesPaidOnTimeUntouched",
        label: "Paid on time with no person involved",
        kind: "period",
        format: "ratio",
        of: ["invoicesPaidOnArc"],
      },
      { key: "flagsUpheld", label: "Agent flags a person upheld", kind: "period", format: "ratio", of: ["flagsResolved"] },
      // In shadow mode, a person agrees or disagrees with each payment decision before anything is paid (0086).
      { key: "verdictsAgreed", label: "Shadow mode decisions a person agreed with", kind: "period", format: "ratio", of: ["verdictsGiven"] },
    ],
  },
  {
    id: "safety",
    title: "Safety and controls",
    rows: [
      { key: "policyDepartures", label: "Model disagreed with the written policy", kind: "period", format: "count" },
      { key: "refusedByCode", label: "Decisions refused by code", kind: "period", format: "count" },
      { key: "duplicatesCaught", label: "Duplicate invoices caught", kind: "period", format: "count" },
    ],
  },
];

/** Every row, in the table's order. */
export const FIGURE_ROWS: ReadonlyArray<OpenRow> = FIGURE_GROUPS.flatMap((group) => group.rows);

const COLUMNS: ReadonlyArray<{ side: SideKey; label: string; className: string }> = [
  { side: "customers", label: "Customers", className: "font-semibold text-ink" },
  { side: "ours", label: "Our workspaces", className: "text-ink-3" },
  { side: "total", label: "Total", className: "text-ink-2" },
];

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const PERCENT = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });
const USDC = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * A no-break space. A narrow table may wrap a figure between its parts
 * ("1 h" / "40 min"), but never between a number and its unit, nor inside a
 * ratio, so a phone-width /open never shows "15 of" over "17".
 */
export const NB = " ";

/** Minutes as minutes under an hour, hours and minutes under a day, and days and hours after that. */
function formatDuration(minutes: number): string {
  const total = Math.round(minutes);
  if (total < 60) return `${total}${NB}min`;
  if (total < 1440) return `${Math.floor(total / 60)}${NB}h ${total % 60}${NB}min`;
  return `${Math.floor(total / 1440)}${NB}d ${Math.floor((total % 1440) / 60)}${NB}h`;
}

/** A figure as the page writes it; a missing one (a median of nothing) is a dash. */
export function formatFigure(value: number | null, format: Exclude<Format, "percent" | "ratio">): string {
  if (value === null) return "—";
  if (format === "usdc") return USDC.format(value);
  if (format === "duration") return formatDuration(value);
  return COUNT.format(value);
}

/**
 * A part and its whole, or null when either is missing or the whole is zero,
 * since there is then nothing to measure.
 */
export function partOf(side: SideNumbers, row: OpenRow): { part: number; whole: number } | null {
  const part = side[row.key];
  const parts = (row.of ?? []).map((key) => side[key]);
  if (part === null || parts.some((value) => value === null)) return null;
  const whole = parts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return whole === 0 ? null : { part, whole };
}

export const formatPercent = (part: number, whole: number) => PERCENT.format(part / whole);
export const formatRatio = (part: number, whole: number) => `${COUNT.format(part)}${NB}of${NB}${COUNT.format(whole)}`;

/**
 * A row's cell for one side. A share is a whole percent of its whole, and a
 * ratio is "x of y"; either is a dash when there is nothing to measure.
 */
export function formatRow(side: SideNumbers, row: OpenRow): string {
  if (row.format !== "percent" && row.format !== "ratio") return formatFigure(side[row.key], row.format);
  const share = partOf(side, row);
  if (!share) return "—";
  return row.format === "percent" ? formatPercent(share.part, share.whole) : formatRatio(share.part, share.whole);
}

export function OpenNumbersTable({ numbers, period, label = "Every figure" }: { numbers: OpenNumbers; period: Period; label?: string }) {
  return (
    <Table label={label} containerClassName="rounded-2xl border border-line bg-surface">
      <caption className="sr-only">{`${label}, ${period.label}. Rows marked now are totals at the moment of reading.`}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>Figure</TableHead>
          {COLUMNS.map((column) => (
            <TableHead key={column.side} className={column.side === "customers" ? "text-right text-ink sm:w-36" : "text-right sm:w-36"}>
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      {FIGURE_GROUPS.map((group) => (
        <tbody key={group.id} className="border-t border-line first-of-type:border-t-0">
          <tr className="bg-ground/60">
            <th scope="rowgroup" colSpan={COLUMNS.length + 1} className="px-4 pb-2 pt-4 text-left font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3">
              {group.title}
            </th>
          </tr>
          {group.rows.map((row) => (
            <tr key={row.label} className="border-t border-line/70 transition-colors duration-150 ease-standard hover:bg-raised/40">
              <th scope="row" className="px-4 py-3 text-left align-middle font-normal text-ink">
                {row.label}
                {row.kind === "now" && <span className="ml-2 font-mono text-[0.6875rem] uppercase tracking-[0.11em] text-ink-3">now</span>}
              </th>
              {COLUMNS.map((column) => (
                <td key={column.side} className={`px-4 py-3 text-right align-middle font-mono tabular-nums ${column.className}`}>
                  {formatRow(numbers.sides[column.side], row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      ))}
    </Table>
  );
}
