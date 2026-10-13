import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InReportingCurrency } from "@/components/vx/CashScenarios";
import { CurrencyReport } from "@/components/vx/CurrencyReport";
import { cashScenario, DEFAULT_LEVERS, type ScenarioBasis } from "@/lib/cash-scenarios";
import { buildCurrencyReport, type CurrencyReportInput } from "@/lib/currency-report";
import { money, pegRate, rateBook, referenceRate, type FxRate, type ReportingTotals } from "@/lib/money";
import type { ReportBill, ReportFacts } from "@/lib/workspace-report";

/**
 * USDC beside US dollars (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M2, M4, M8): the report and
 * Treasury reach the dollar from USDC only by the 1 USDC = 1 USD redemption peg, named as such with its kind, never a
 * silent 1:1 and never a US dollar balance; and each stored rate shows its time and its age.
 */

vi.mock("@/app/actions/currency", () => ({ saveCashScenarioAction: vi.fn(), setReportingCurrencyAction: vi.fn() }));

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:])/g, "$1")
    .trim();

const NOW = "2026-10-13T12:00:00.000Z";
const ref = (currency: string, perUsd: string, at = "2026-10-13T00:02:00.000Z") => referenceRate(currency, perUsd, "ExchangeRate-API", at) as FxRate;

function bill(id: string, over: Partial<ReportBill> = {}): ReportBill {
  return {
    id,
    createdAt: "2026-10-10T10:00:00.000Z",
    dueDate: "2026-10-20T00:00:00.000Z",
    amount: 100,
    currency: "USDC",
    status: "paid",
    reviewedBy: null,
    paidAmount: null,
    discount: null,
    bill: null,
    payee: { id: `payee-${id}`, name: `Payee ${id}`, mirror: false, sample: false },
    ...over,
  };
}

/** A generator that is the same on every machine. */
function generator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function report(bills: ReportBill[], over: Partial<CurrencyReportInput> = {}) {
  const facts: ReportFacts = {
    network: "arc-testnet",
    sandbox: false,
    now: NOW,
    openedAt: "2026-10-01T00:00:00.000Z",
    shadow: null,
    bills,
    decisions: [],
    personActions: [],
    verdicts: [],
    payments: bills.map((one) => ({ invoiceId: one.id, amount: one.amount, token: "USDC" as const, txHash: `0x${"c".repeat(64)}`, at: "2026-10-12T15:00:00.000Z", simulated: false })),
  };
  return buildCurrencyReport(facts, {
    reporting: "USD",
    available: true,
    book: rateBook([ref("SGD", "1.35")]),
    sources: new Map(bills.map((one) => [one.id, "console"])),
    actuals: null,
    variances: { available: true, recorded: [], unknown: [] },
    manualAdjustments: 0,
    ...over,
  });
}

/** Every row in USDC reaches US dollars by the peg alone, said as a rate of kind `peg`, and only then is it added. */
function pegged(totals: ReportingTotals): void {
  for (const row of totals.rows) {
    if (row.total.currency === "USD") expect(row.value.state).toBe("same");
    if (row.total.currency !== "USDC") continue;
    expect(row.value.state).toBe("converted");
    if (row.value.state !== "converted") continue;
    expect(row.value.rates).toEqual([pegRate("USDC")]);
    expect(row.value.rates[0].kind).toBe("peg");
  }
}

describe("USDC beside US dollars in the report", () => {
  it("never sums USDC into a US dollar total without the redemption peg, said as a rate of its own kind", () => {
    const random = generator(20_261_013);
    for (let run = 0; run < 200; run += 1) {
      const usdc = Math.round(random() * 1_000_000) / 100;
      const usd = Math.round(random() * 1_000_000) / 100;
      const built = report([
        bill("usdc", { amount: usdc }),
        bill("usd", { amount: usd, bill: { amount: usd, currency: "USD" }, conversion: { perUsd: 1, source: "USD = USDC", at: "2026-10-10T00:00:00.000Z" } }),
      ]);
      pegged(built.billsAsWritten);
      pegged(built.paidOnArc);
      expect(built.billsAsWritten.total).toEqual({ state: "known", money: money(Math.round(usdc * 100) + Math.round(usd * 100), "USD") });
      expect(built.rates).toContainEqual(pegRate("USDC"));
    }
  });

  it("names the peg on each row, on the total and in the rates used, never as a dollar balance", () => {
    const built = report([bill("usdc", { amount: 250 }), bill("sgd", { amount: 1000, bill: { amount: 1350, currency: "SGD" }, conversion: { perUsd: 1.35, source: "ExchangeRate-API", at: "2026-10-10T00:02:00.000Z" } })]);
    const shown = text(renderToStaticMarkup(<CurrencyReport report={built} settingsHref="#" asOf={NOW} />));
    expect(shown).toContain("1 USDC = 1 USD, redemption peg");
    expect(shown).toMatch(/Total in USD: 1,250\.00 USD, USDC counted at its 1:1 redemption peg\./);
    expect(shown).toContain("Redemption peg: 1 USDC = 1 USD, redemption peg (USDC's 1:1 dollar redemption), not a market rate.");
    expect(shown).not.toMatch(/1 USDC = 1 USD(?!, redemption peg)/);
    // Payments are said as they settle, and a variance KPI claims no move of the rate it did not see.
    expect(shown).toContain("Payments still settle in USDC or EURC.");
    expect(shown).toContain("0 paid bills, each valued at the rate on its payment day.");
    // Each stored rate with its time and its age, as of the report.
    expect(shown).toContain("1 USD = 1.3500 SGD, reference rate from ExchangeRate-API, published 13 Oct 2026, 00:02 UTC, 11 hours old.");
  });
});

describe("USDC beside the reporting currency on Treasury", () => {
  const BASIS: ScenarioBasis = { today: "2026-10-13", cash: 1000, reserve: 0, outflows: [], receivables: [], clients: {}, eurc: [], recurringRead: true };
  const result = cashScenario(BASIS, { ...DEFAULT_LEVERS, horizon: 30 });

  it("values the USDC held by the redemption peg, said, and never calls it US dollars held", () => {
    const shown = text(renderToStaticMarkup(<InReportingCurrency result={result} reporting={{ currency: "USD", rates: [], missing: {}, asOf: NOW }} />));
    expect(shown).toContain("In USD, valued from USDC: cash today 1,000.00 USD; lowest in this scenario 1,000.00 USD.");
    expect(shown).toContain("At 1 USDC = 1 USD, redemption peg (USDC's 1:1 dollar redemption), not a market rate.");
  });

  it("gives the reference rate it then used with its time and its age", () => {
    const shown = text(renderToStaticMarkup(<InReportingCurrency result={result} reporting={{ currency: "SGD", rates: [ref("SGD", "1.35")], missing: {}, asOf: NOW }} />));
    expect(shown).toContain("In SGD, valued from USDC: cash today 1,350.00 SGD");
    expect(shown).toContain("then 1 USD = 1.3500 SGD, reference rate from ExchangeRate-API, published 13 Oct 2026, 00:02 UTC, 11 hours old.");
  });
});
