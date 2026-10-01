import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import type { OpenNumbers, Period, SideKey, SideNumbers } from "@/lib/platform/open-numbers";

/**
 * The open numbers table (spec §2): one row per figure, one column each for
 * customers' workspaces, ours and the total. A `now` row is a total at the
 * moment of reading; every other row covers the chosen period.
 */
type Format = "count" | "usdc" | "duration";

export const OPEN_ROWS: ReadonlyArray<{ key: keyof SideNumbers; label: string; kind: "period" | "now"; format: Format }> = [
  { key: "workspacesOpened", label: "Workspaces opened", kind: "period", format: "count" },
  { key: "liveWorkspaces", label: "Workspaces live on Arc testnet", kind: "now", format: "count" },
  { key: "people", label: "People in workspaces", kind: "now", format: "count" },
  { key: "payments", label: "Payments settled on Arc testnet", kind: "period", format: "count" },
  { key: "usdcPaid", label: "USDC paid", kind: "period", format: "usdc" },
  { key: "payees", label: "Payee wallets paid", kind: "period", format: "count" },
  { key: "firstPayments", label: "Workspaces that made a first payment on Arc testnet", kind: "period", format: "count" },
  { key: "medianMinutesToFirstPayment", label: "Median time from workspace opened to first payment", kind: "period", format: "duration" },
  { key: "invoicesDecided", label: "Invoices decided", kind: "period", format: "count" },
  { key: "milestonesReleased", label: "Contractor milestones paid on Arc testnet", kind: "period", format: "count" },
  { key: "cycles", label: "Agent cycles run", kind: "period", format: "count" },
  { key: "modelDecisions", label: "Decisions made by a model", kind: "period", format: "count" },
  { key: "policyDepartures", label: "Model departed from the written policy", kind: "period", format: "count" },
  { key: "refusedByCode", label: "Decisions refused by code", kind: "period", format: "count" },
  { key: "usdcInWallets", label: "USDC in Arc testnet wallets", kind: "now", format: "usdc" },
];

const COLUMNS: ReadonlyArray<{ side: SideKey; label: string }> = [
  { side: "customers", label: "Customers" },
  { side: "ours", label: "Our workspaces" },
  { side: "total", label: "Total" },
];

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const USDC = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Minutes as minutes under an hour, hours and minutes under a day, and days and hours after that. */
function formatDuration(minutes: number): string {
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  if (total < 1440) return `${Math.floor(total / 60)} h ${total % 60} min`;
  return `${Math.floor(total / 1440)} d ${Math.floor((total % 1440) / 60)} h`;
}

/** A figure as the table writes it; a missing one (a median of nothing) is a dash. */
export function formatFigure(value: number | null, format: Format): string {
  if (value === null) return "—";
  if (format === "usdc") return USDC.format(value);
  if (format === "duration") return formatDuration(value);
  return COUNT.format(value);
}

export function OpenNumbersTable({ numbers, period }: { numbers: OpenNumbers; period: Period }) {
  return (
    <Table label="Open numbers" containerClassName="rounded-2xl border border-line bg-surface shadow-surface">
      <caption className="sr-only">{`${period.label}. Rows marked now are totals at the moment of reading.`}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>Figure</TableHead>
          {COLUMNS.map((column) => (
            <TableHead key={column.side} className="text-right">
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {OPEN_ROWS.map((row) => (
          <TableRow key={row.key}>
            <th scope="row" className="px-4 py-3 text-left align-middle font-normal text-ink">
              {row.label}
              {row.kind === "now" && <span className="ml-2 font-mono text-[0.6875rem] uppercase tracking-[0.11em] text-ink-3">now</span>}
            </th>
            {COLUMNS.map((column) => (
              <TableCell
                key={column.side}
                className={column.side === "total" ? "text-right font-mono font-semibold tabular-nums" : "text-right font-mono tabular-nums text-ink-2"}
              >
                {formatFigure(numbers.sides[column.side][row.key], row.format)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
