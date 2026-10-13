import type { ActualRecord } from "./actual-payment-fields";
import { buildCurrencyReport, currenciesNeeded, type CurrencyReport } from "./currency-report";
import { unwrap, type OrgDb } from "./dal";
import { countManualRates, reportingRateBook } from "./fx/rates-store";
import { readFxVariances, readFxVarianceState, type VariancesRead } from "./fx/variances";
import { rateBook, type RateBook } from "./money";
import { readReportingCurrency } from "./reporting-currency";
import type { ReportFacts } from "./workspace-report";

/**
 * Reads what the report's **Currencies and rates** needs (docs/superpowers/specs/2026-10-13-currency-provenance-
 * design.md M8), inside the workspace's organization scope: the reporting currency, where each bill came from (its
 * `create_invoice` entry's `via`), the reference rates for the currencies its figures are in, the FX variances and the
 * manual adjustments. Reads only, while the report renders: the rates and variances are those the hourly rates job
 * stored, never the feed read here, and nothing is written. Each part is best effort on its own: one that cannot be
 * read shows as unknown or not set up, never as a figure.
 */

const PAGE = 1000;

/** Each bill's `via`, by invoice id: `console` where its entry names none. */
async function billSources(orgDb: OrgDb): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (let from = 0; ; from += PAGE) {
    const page = unwrap(
      await orgDb
        .from("ledger_entries")
        .select("seq, invoice_id:detail->>invoiceId, via:detail->>via")
        .eq("action", "create_invoice")
        .order("seq", { ascending: true })
        .range(from, from + PAGE - 1)
    ) as Array<{ invoice_id: string | null; via: string | null }>;
    for (const row of page) if (row.invoice_id) sources.set(row.invoice_id, row.via ?? "console");
    if (page.length < PAGE) return sources;
  }
}

export async function readCurrencyReport(orgDb: OrgDb, facts: ReportFacts, actuals: readonly ActualRecord[] | null, now: Date): Promise<CurrencyReport> {
  const setting = await readReportingCurrency(orgDb).catch((error: unknown) => {
    console.error("report: reporting currency not read", error instanceof Error ? error.message : error);
    return { available: false as const };
  });
  const reporting = setting.available ? (setting.setting?.currency ?? null) : null;
  const needed = currenciesNeeded(facts, actuals, reporting);
  const [sources, book, variances, manualAdjustments] = await Promise.all([
    billSources(orgDb).catch((error: unknown) => {
      console.error("report: bill sources not read", error instanceof Error ? error.message : error);
      return new Map<string, string>();
    }),
    reportingRateBook(orgDb, needed, now).catch((error: unknown): RateBook => {
      console.error("report: rates not read", error instanceof Error ? error.message : error);
      return rateBook([], Object.fromEntries(needed.map((code) => [code, `The ${code} rate could not be read.`])));
    }),
    // The variances the job recorded, and each paid bill without one as unknown; a failure still shows those recorded.
    readFxVarianceState(orgDb).catch(async (error: unknown): Promise<VariancesRead> => {
      console.error("report: FX variances not read", error instanceof Error ? error.message : error);
      const read = await readFxVariances(orgDb).catch(() => ({ available: false as const }));
      return read.available ? { ...read, unknown: [] } : read;
    }),
    countManualRates(orgDb).catch(() => null),
  ]);
  return buildCurrencyReport(facts, {
    reporting,
    available: setting.available,
    book,
    sources,
    actuals,
    variances: variances.available ? variances : { available: false, recorded: [], unknown: [] },
    manualAdjustments,
  });
}
