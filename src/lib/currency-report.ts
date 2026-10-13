import type { ActualRecord } from "./actual-payment-fields";
import { currentActuals } from "./actual-payments-compare";
import type { RecordedVariance, UnknownVariance } from "./fx/variances";
import {
  fullProvenance,
  pegRate,
  provenanceShare,
  referenceRate,
  reportingTotals,
  roundedMoney,
  sameRate,
  toReporting,
  totalsByCurrency,
  type FxRate,
  type Money,
  type MoneyFigure,
  type RateBook,
  type ReportingTotals,
} from "./money";
import { reportScope, type ReportFacts } from "./workspace-report";

/**
 * The report's **Currencies and rates** (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M8): the bills
 * the report counts as written, what was paid on Arc and what the business recorded paying, each per currency and in the
 * reporting currency with its rates, or unknown; the FX variance on paid bills; and the two KPIs, the share of amounts
 * with full provenance and the manual FX adjustments. Pure: the reads come in (`readReportFacts`, the actuals, the
 * variances recorded, the rates) and every rule here is tested on hand-made rows. Two currencies are never added
 * together, USD and USDC included, but in the reporting currency with the rates said.
 */

/** Where a bill's amount came from, by the `via` its `create_invoice` entry records. */
export const SOURCE_WORDS: Record<string, string> = {
  console: "Bill to pay",
  import: "a bill list",
  email: "an emailed invoice",
  api: "the API",
  telegram: "Telegram",
  slack: "Slack",
  deal: "a deal",
  xero: "Xero",
  quickbooks: "QuickBooks",
  github: "GitHub",
  schedule: "a recurring payment",
};

export interface CurrencyReportInput {
  /** The reporting currency; null when none is set or it is not set up. */
  reporting: string | null;
  /** False before migration 0113 runs. */
  available: boolean;
  book: RateBook;
  /** Each bill's `via`, by its id: `console` for one added in the console with none; absent when no entry was read. */
  sources: ReadonlyMap<string, string>;
  actuals: readonly ActualRecord[] | null;
  variances: { available: boolean; recorded: readonly RecordedVariance[]; unknown: readonly UnknownVariance[] };
  /** Rates typed into saved scenarios; null before 0113 runs. */
  manualAdjustments: number | null;
}

export interface VarianceRow extends RecordedVariance {
  payee: string;
}

export interface CurrencyReport {
  reporting: string | null;
  available: boolean;
  billsAsWritten: ReportingTotals;
  paidOnArc: ReportingTotals;
  /** Null before migration 0090 runs. */
  paidByBusiness: ReportingTotals | null;
  variance: {
    rows: VarianceRow[];
    /** The variances added up per currency (USDC), never across currencies. */
    totals: Array<{ total: Money; count: number }>;
    unknown: Array<UnknownVariance & { payee: string }>;
    /** Paid bills in a currency of their own, in dollars, that carry no variance: the dollar never moves against itself. */
    inDollars: number;
  };
  provenance: { full: number; total: number };
  manualAdjustments: number | null;
  /** Every rate a figure here used, once, with its kind, source and time. */
  rates: FxRate[];
  /** The figures the KPI counted, for the page to say why one is partial. */
  figures: Array<{ invoiceId: string; payee: string; figure: MoneyFigure; full: boolean }>;
}

/** The rates that took a bill as written to the USDC it is paid in: its reference rate, then USDC's redemption. */
export function conversionOf(bill: ReportFacts["bills"][number]): FxRate[] {
  if (!bill.bill || !bill.conversion) return [];
  const peg = pegRate("USDC");
  if (bill.bill.currency === "USD") return [peg];
  const rate = referenceRate(bill.bill.currency, typeof bill.conversion.perUsd === "number" ? String(bill.conversion.perUsd) : bill.conversion.perUsd, bill.conversion.source, new Date(bill.conversion.at).toISOString());
  return rate ? [rate, peg] : [];
}

export function buildCurrencyReport(facts: ReportFacts, input: CurrencyReportInput): CurrencyReport {
  const { bills, payments } = reportScope(facts);
  const reporting = input.available ? input.reporting : null;
  const payeeOf = new Map(bills.map((bill) => [bill.id, bill.payee.name]));
  const paidIds = new Set(payments.map((payment) => payment.invoiceId));
  const recorded = new Map(input.variances.recorded.map((row) => [row.invoiceId, row]));

  const figures = bills.map((bill) => {
    const executable = roundedMoney(bill.amount, bill.currency);
    const document = bill.bill ? roundedMoney(bill.bill.amount, bill.bill.currency) : executable;
    const via = input.sources.get(bill.id);
    const conversion = conversionOf(bill);
    const converted = bill.bill !== null && bill.bill.currency !== "USD";
    const paid = paidIds.has(bill.id);
    const figure: MoneyFigure = {
      document,
      source: via ? (SOURCE_WORDS[via] ?? via) : "",
      executable,
      conversion,
      reporting: toReporting(document, reporting, input.book),
      // The rate at payment applies to a converted bill that was paid; it is known once its variance is recorded.
      ...(converted && paid && input.variances.available ? { paymentRate: recorded.get(bill.id)?.payment ?? null } : {}),
    };
    return { invoiceId: bill.id, payee: bill.payee.name, figure, full: fullProvenance(figure) };
  });

  const billsAsWritten = reportingTotals(
    figures.map(({ figure }) => figure.document),
    reporting,
    input.book
  );
  const paidOnArc = reportingTotals(
    payments.map((payment) => roundedMoney(payment.amount, payment.token)),
    reporting,
    input.book
  );
  const inScope = new Set(bills.map((bill) => bill.id));
  const paidByBusiness = input.actuals
    ? reportingTotals(
        [...currentActuals(input.actuals)]
          .filter(([invoiceId, { current }]) => inScope.has(invoiceId) && current.outcome === "paid" && current.amount !== null && current.currency)
          .map(([, { current }]) => roundedMoney(current.amount as number, current.currency as string)),
        reporting,
        input.book
      )
    : null;

  const rows: VarianceRow[] = input.variances.recorded
    .filter((row) => paidIds.has(row.invoiceId))
    .map((row) => ({ ...row, payee: payeeOf.get(row.invoiceId) ?? "a supplier" }))
    .sort((a, b) => Date.parse(b.paidAt) - Date.parse(a.paidAt) || a.invoiceId.localeCompare(b.invoiceId));
  const unknown = input.variances.unknown.filter((row) => paidIds.has(row.invoiceId)).map((row) => ({ ...row, payee: payeeOf.get(row.invoiceId) ?? "a supplier" }));
  const inDollars = bills.filter((bill) => paidIds.has(bill.id) && bill.bill?.currency === "USD").length;

  const rates: FxRate[] = [];
  const keep = (rate: FxRate) => {
    if (!rates.some((seen) => sameRate(seen, rate))) rates.push(rate);
  };
  for (const totals of [billsAsWritten, paidOnArc, paidByBusiness]) for (const rate of totals?.rates ?? []) keep(rate);
  for (const { figure } of figures) for (const rate of figure.conversion) keep(rate);
  for (const row of rows) {
    keep(row.decision);
    keep(row.payment);
  }

  return {
    reporting,
    available: input.available,
    billsAsWritten,
    paidOnArc,
    paidByBusiness,
    variance: { rows, totals: totalsByCurrency(rows.map((row) => row.variance)), unknown, inDollars },
    provenance: provenanceShare(figures.map(({ figure }) => figure)),
    manualAdjustments: input.manualAdjustments,
    rates: rates.sort((a, b) => kindOrder(a) - kindOrder(b) || a.to.localeCompare(b.to) || Date.parse(b.at || "0") - Date.parse(a.at || "0")),
    figures,
  };
}

const KIND_ORDER = { reference: 0, quote: 1, accounting: 2, manual: 3, peg: 4 } as const;
const kindOrder = (rate: FxRate) => KIND_ORDER[rate.kind];

/** The currencies whose reference rate the report needs: every one its figures are in, and the reporting currency. */
export function currenciesNeeded(facts: ReportFacts, actuals: readonly ActualRecord[] | null, reporting: string | null): string[] {
  const { bills, payments } = reportScope(facts);
  const codes = new Set<string>();
  for (const bill of bills) codes.add(bill.bill?.currency ?? bill.currency);
  for (const payment of payments) codes.add(payment.token);
  for (const record of actuals ?? []) if (record.currency) codes.add(record.currency);
  if (reporting) codes.add(reporting);
  // A token reaches its currency by the peg; the euro's own rate takes EURC on to the reporting currency.
  if (codes.has("EURC")) codes.add("EUR");
  return [...codes].filter((code) => code !== "USDC" && code !== "EURC" && code !== "USD").sort();
}
