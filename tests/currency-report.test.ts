import { describe, expect, it } from "vitest";
import type { ActualRecord } from "@/lib/actual-payment-fields";
import { buildCurrencyReport, conversionOf, currenciesNeeded, type CurrencyReportInput } from "@/lib/currency-report";
import type { RecordedVariance } from "@/lib/fx/variances";
import { formatMoney, money, rateBook, referenceRate, type FxRate } from "@/lib/money";
import type { ReportBill, ReportFacts, ReportPayment } from "@/lib/workspace-report";

/**
 * The report's Currencies and rates (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M3, M6, M8): each
 * figure in its own currency, then in the reporting currency with its rates or unknown; the FX variance on paid bills;
 * the share of amounts with full provenance; never a sum across currencies, USD and USDC included.
 */

const ref = (currency: string, perUsd: string, at = "2026-10-13T00:02:00.000Z") => referenceRate(currency, perUsd, "ExchangeRate-API", at) as FxRate;

function bill(id: string, over: Partial<ReportBill> = {}): ReportBill {
  return {
    id,
    createdAt: "2026-10-10T10:00:00.000Z",
    dueDate: "2026-10-20T00:00:00.000Z",
    amount: 100,
    currency: "USDC",
    status: "pending",
    reviewedBy: null,
    paidAmount: null,
    discount: null,
    bill: null,
    payee: { id: `payee-${id}`, name: `Payee ${id}`, mirror: false, sample: false },
    ...over,
  };
}
const sgd = (id: string, sgdAmount: number, usdc: number, over: Partial<ReportBill> = {}) =>
  bill(id, { amount: usdc, bill: { amount: sgdAmount, currency: "SGD" }, conversion: { perUsd: 1.35, source: "ExchangeRate-API", at: "2026-10-10T00:02:00.000Z" }, ...over });
const payment = (invoiceId: string, amount: number, over: Partial<ReportPayment> = {}): ReportPayment => ({
  invoiceId,
  amount,
  token: "USDC",
  txHash: `0x${"b".repeat(64)}`,
  at: "2026-10-12T15:00:00.000Z",
  simulated: false,
  ...over,
});
const facts = (over: Partial<ReportFacts> = {}): ReportFacts => ({
  network: "arc-testnet",
  sandbox: false,
  now: "2026-10-13T12:00:00.000Z",
  openedAt: "2026-10-01T00:00:00.000Z",
  shadow: { currency: "SGD", startedAt: "2026-10-01T00:00:00.000Z" },
  bills: [],
  decisions: [],
  personActions: [],
  verdicts: [],
  payments: [],
  ...over,
});

const variance = (invoiceId: string): RecordedVariance => ({
  invoiceId,
  currency: "SGD",
  paid: money(1_000_000_000, "USDC"),
  paidAt: "2026-10-12T15:00:00.000Z",
  covered: money(135_000, "SGD"),
  decision: ref("SGD", "1.35", "2026-10-10T00:02:00.000Z"),
  payment: ref("SGD", "1.36", "2026-10-12T00:02:00.000Z"),
  valueAtPayment: money(992_650_000, "USDC"),
  variance: money(7_350_000, "USDC"),
  recordedAt: "2026-10-13T00:00:00.000Z",
});

const input = (over: Partial<CurrencyReportInput> = {}): CurrencyReportInput => ({
  reporting: "SGD",
  available: true,
  book: rateBook([ref("SGD", "1.35"), ref("JPY", "150")], { KRW: "No KRW rate was recorded." }),
  sources: new Map([
    ["paid", "xero"],
    ["open", "import"],
    ["yen", "console"],
    ["won", "console"],
  ]),
  actuals: null,
  variances: { available: true, recorded: [], unknown: [] },
  manualAdjustments: 2,
  ...over,
});

const MIXED = facts({
  bills: [
    sgd("paid", 1350, 1000, { status: "paid" }),
    sgd("open", 675, 500),
    bill("yen", { amount: 1000, bill: { amount: 150000, currency: "JPY" }, conversion: { perUsd: 150, source: "ExchangeRate-API", at: "2026-10-11T00:02:00.000Z" } }),
    bill("won", { amount: 1086.96, bill: { amount: 1500000, currency: "KRW" }, conversion: { perUsd: 1380, source: "ExchangeRate-API", at: "2026-10-11T00:02:00.000Z" } }),
  ],
  payments: [payment("paid", 1000)],
});

describe("buildCurrencyReport", () => {
  it("totals bills as written per currency, and in the reporting currency with its rates, unknown where a rate is missing", () => {
    const report = buildCurrencyReport(MIXED, input());
    expect(report.billsAsWritten.rows.map((row) => [formatMoney(row.total), row.count, row.value.state])).toEqual([
      ["150,000 JPY", 1, "converted"],
      ["1,500,000 KRW", 1, "unknown"],
      ["2,025.00 SGD", 2, "same"],
    ]);
    // 150,000 JPY is 1,000 US dollars, 1,350.00 SGD at 1.35; with 2,025.00 SGD, 3,375.00 SGD without the won.
    expect(report.billsAsWritten.total).toEqual({ state: "unknown", known: money(337_500, "SGD"), missing: ["KRW"] });
  });

  it("keeps what was paid on Arc in USDC, and reaches SGD only by the peg and the reference rate, both listed", () => {
    const report = buildCurrencyReport(MIXED, input());
    expect(report.paidOnArc.rows.map((row) => formatMoney(row.total))).toEqual(["1,000.00 USDC"]);
    expect(report.paidOnArc.total).toEqual({ state: "known", money: money(135_000, "SGD") });
    expect(report.rates.map((rate) => `${rate.kind}:${rate.from}>${rate.to}@${rate.value}`)).toEqual(
      expect.arrayContaining(["peg:USDC>USD@1", "reference:USD>SGD@1.35", "reference:USD>JPY@150"])
    );
  });

  it("never converts without a reporting currency, and never adds across currencies then", () => {
    const report = buildCurrencyReport(MIXED, input({ reporting: null }));
    expect(report.billsAsWritten.total).toEqual({ state: "not_set" });
    expect(report.billsAsWritten.rows.every((row) => row.value.state === "not_set")).toBe(true);
  });

  it("shows the variance of a paid converted bill in scope, and an unknown one with its reason", () => {
    const report = buildCurrencyReport(
      MIXED,
      input({
        variances: {
          available: true,
          recorded: [variance("paid"), variance("not-in-scope")],
          unknown: [{ invoiceId: "paid", currency: "SGD", paidAt: "2026-10-12T15:00:00.000Z", reason: "No SGD rate was recorded in the 36 hours before the payment." }],
        },
      })
    );
    expect(report.variance.rows.map((row) => [row.payee, formatMoney(row.variance, { sign: true })])).toEqual([["Payee paid", "+7.35 USDC"]]);
    expect(report.variance.totals.map(({ total }) => formatMoney(total))).toEqual(["7.35 USDC"]);
    expect(report.variance.unknown.map((row) => row.payee)).toEqual(["Payee paid"]);
  });

  it("counts full provenance: a source, a conversion with its time, a known reporting value, and the rate at payment", () => {
    const without = buildCurrencyReport(MIXED, input());
    // The won has no reporting value, and the paid bill no rate at payment yet: 2 of 4.
    expect(without.provenance).toEqual({ full: 2, total: 4 });
    expect(without.figures.filter((row) => !row.full).map((row) => row.invoiceId).sort()).toEqual(["paid", "won"]);
    const recorded = buildCurrencyReport(MIXED, input({ variances: { available: true, recorded: [variance("paid")], unknown: [] } }));
    expect(recorded.provenance).toEqual({ full: 3, total: 4 });
    // A bill whose entry was never read has no source: partial.
    const unsourced = buildCurrencyReport(MIXED, input({ sources: new Map(), variances: { available: true, recorded: [variance("paid")], unknown: [] } }));
    expect(unsourced.provenance.full).toBe(0);
  });

  it("totals what the business recorded paying, its newest record per bill, per currency", () => {
    const record = (id: string, invoiceId: string, amount: number, currency: string, over: Partial<ActualRecord> = {}): ActualRecord => ({
      id,
      invoiceId,
      outcome: "paid",
      paidOn: "2026-10-12",
      amount,
      currency,
      method: "bank_transfer",
      reference: null,
      note: null,
      reason: null,
      replaces: null,
      source: "form",
      recordedBy: null,
      recordedAt: "2026-10-12T10:00:00.000Z",
      ...over,
    });
    const report = buildCurrencyReport(
      MIXED,
      input({
        actuals: [
          record("a1", "paid", 1300, "SGD"),
          record("a2", "paid", 1350, "SGD", { replaces: "a1", recordedAt: "2026-10-12T11:00:00.000Z" }),
          record("b1", "yen", 150000, "JPY"),
          record("c1", "someone-else", 99, "MYR"),
        ],
      })
    );
    expect(report.paidByBusiness?.rows.map((row) => formatMoney(row.total))).toEqual(["150,000 JPY", "1,350.00 SGD"]);
    expect(report.paidByBusiness?.total).toEqual({ state: "known", money: money(270_000, "SGD") });
  });

  it("before migration 0113 runs, reports nothing in a reporting currency", () => {
    const report = buildCurrencyReport(MIXED, input({ available: false, manualAdjustments: null, variances: { available: false, recorded: [], unknown: [] } }));
    expect(report.reporting).toBeNull();
    expect(report.billsAsWritten.total).toEqual({ state: "not_set" });
    // Without the variances' table the rate at payment is not counted against a paid bill.
    expect(report.provenance).toEqual({ full: 4, total: 4 });
  });
});

describe("conversionOf and currenciesNeeded", () => {
  it("says a bill's conversion as its reference rate then USDC's redemption; a dollar bill by the redemption alone", () => {
    expect(conversionOf(sgd("x", 1350, 1000)).map((rate) => rate.kind)).toEqual(["reference", "peg"]);
    expect(conversionOf(bill("usd", { bill: { amount: 100, currency: "USD" }, conversion: { perUsd: 1, source: "USD = USDC", at: "2026-10-10T00:00:00.000Z" } })).map((rate) => rate.kind)).toEqual(["peg"]);
    expect(conversionOf(bill("plain"))).toEqual([]);
  });

  it("asks for the rate of every currency a figure is in and the reporting currency, the euro for EURC, never the dollar or a token", () => {
    const withEurc = facts({ ...MIXED, payments: [payment("paid", 1000), payment("open", 50, { token: "EURC" })] });
    expect(currenciesNeeded(withEurc, null, "MYR")).toEqual(["EUR", "JPY", "KRW", "MYR", "SGD"]);
  });
});
