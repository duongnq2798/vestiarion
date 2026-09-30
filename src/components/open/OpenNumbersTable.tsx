import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import type { OpenNumbers, Period, SideKey, SideNumbers } from "@/lib/platform/open-numbers";

/**
 * The open numbers table (spec §2): one row per figure, one column each for
 * customers' workspaces, ours and the total. A `now` row is a total at the
 * moment of reading; every other row covers the chosen period.
 */
export const OPEN_ROWS: ReadonlyArray<{ key: keyof SideNumbers; label: string; kind: "period" | "now"; format: "count" | "usdc" }> = [
  { key: "workspacesOpened", label: "Workspaces opened", kind: "period", format: "count" },
  { key: "liveWorkspaces", label: "Workspaces live on Arc testnet", kind: "now", format: "count" },
  { key: "people", label: "People in workspaces", kind: "now", format: "count" },
  { key: "payments", label: "Payments settled on Arc testnet", kind: "period", format: "count" },
  { key: "usdcPaid", label: "USDC paid", kind: "period", format: "usdc" },
  { key: "payees", label: "Payee wallets paid", kind: "period", format: "count" },
  { key: "invoicesDecided", label: "Invoices decided", kind: "period", format: "count" },
  { key: "milestonesReleased", label: "Contractor milestones paid", kind: "period", format: "count" },
  { key: "cycles", label: "Agent cycles run", kind: "period", format: "count" },
  { key: "modelDecisions", label: "Decisions made by a model", kind: "period", format: "count" },
  { key: "policyDepartures", label: "Model departed from the written policy", kind: "period", format: "count" },
  { key: "refusedByCode", label: "Model overruled by code", kind: "period", format: "count" },
  { key: "usdcInWallets", label: "USDC in Arc testnet wallets", kind: "now", format: "usdc" },
];

const COLUMNS: ReadonlyArray<{ side: SideKey; label: string }> = [
  { side: "customers", label: "Customers" },
  { side: "ours", label: "Our workspaces" },
  { side: "total", label: "Total" },
];

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const USDC = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatFigure(value: number, format: "count" | "usdc"): string {
  return format === "usdc" ? USDC.format(value) : COUNT.format(value);
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
