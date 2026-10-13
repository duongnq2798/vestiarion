import type { OrgDb } from "../dal";
import type { FxRate } from "../money";
import { readReportingCurrency } from "../reporting-currency";
import { reportingRateBook } from "./rates-store";

/**
 * The rates Treasury's What if section offers and totals with (docs/superpowers/specs/2026-10-13-currency-provenance-
 * design.md M4, M7): today's reference rate for each currency an open bill was written in, and the workspace's
 * reporting currency with the rates it needs. Read and stored inside the workspace's scope; a rate the feed did not
 * give is missing, with why, never guessed. Plain values, so they cross to the browser.
 */

export interface PlanningRates {
  /** Today's reference rate by currency: how many of it make one US dollar, its source and when it was published. */
  rateHints: Record<string, { currency: string; perUsd: string; source: string; at: string }>;
  /** The reporting currency and its rates, or null when none is set or it cannot be read. */
  reporting: { currency: string; rates: FxRate[]; missing: Record<string, string> } | null;
}

export async function readPlanningRates(orgDb: OrgDb, foreignCurrencies: readonly string[], now: Date): Promise<PlanningRates> {
  const setting = await readReportingCurrency(orgDb).catch((error: unknown) => {
    console.error("planning: reporting currency not read", error instanceof Error ? error.message : error);
    return { available: false as const };
  });
  const reporting = setting.available ? (setting.setting?.currency ?? null) : null;
  const book = await reportingRateBook(orgDb, [...foreignCurrencies, ...(reporting ? [reporting] : [])], now);
  const rateHints: PlanningRates["rateHints"] = {};
  for (const currency of foreignCurrencies) {
    const rate = book.rates.get(currency);
    if (rate) rateHints[currency] = { currency, perUsd: rate.value, source: rate.source, at: rate.at };
  }
  return {
    rateHints,
    reporting: reporting ? { currency: reporting, rates: [...book.rates.values()], missing: Object.fromEntries(book.missing) } : null,
  };
}
