import { db, type OrgDb } from "../dal";
import { rateBook, rateTime, rateValue, referenceRate, type FxRate, type RateBook } from "../money";
import { usdRate, type UsdRate } from "./usd-rates";

/**
 * The rates a workspace used, stored with their kind, source and time (docs/superpowers/specs/2026-10-13-currency-
 * provenance-design.md M5), in `fx_rates` (0113), inside the workspace's organization scope. Reference rates come from
 * the feed shadow mode already reads (`usdRate`: ExchangeRate-API, at most once an hour per server); a rate the feed
 * did not give is said, never guessed. Nothing that decides or pays reads this module.
 *
 * Before migration 0113 runs, reading answers as if nothing was stored and recording stores nothing: a figure then
 * shows the rate read from the feed, or unknown.
 */

export const REFERENCE_SOURCE = "ExchangeRate-API";
/** A reporting figure counts a reference rate published within this long: the feed publishes daily. */
export const REPORT_RATE_MAX_AGE_MS = 3 * 24 * 60 * 60_000;
/** A stored rate younger than this needs no new read of the feed. */
const FRESH_MS = 26 * 60 * 60_000;

type PostgrestError = { code?: string; message?: string } | null;

/** The table or a column is not there yet: migration 0113 has not run (42P01, PGRST205, 42703, PGRST204). */
export function notSetUp(error: PostgrestError): boolean {
  if (!error) return false;
  return ["42P01", "PGRST205", "42703", "PGRST204"].includes(error.code ?? "") || /(fx_rates|fx_variances|reporting_currencies|cash_scenario_versions).*(schema cache|does not exist)/.test(error.message ?? "");
}

type RateRow = { id: string; base: string; quote: string; rate: number | string; kind: string; source: string; published_at: string };

export function rateOfRow(row: RateRow): FxRate | null {
  const value = rateValue(typeof row.rate === "number" ? row.rate : String(row.rate));
  if (value === null) return null;
  const kind = row.kind === "reference" || row.kind === "quote" || row.kind === "accounting" || row.kind === "manual" ? row.kind : null;
  if (!kind) return null;
  return { id: row.id, from: row.base, to: row.quote, value, kind, source: row.source, at: new Date(row.published_at).toISOString() };
}

const RATE_COLUMNS = "id, base, quote, rate, kind, source, published_at";

/** The currencies a reference rate is read for: never the dollar itself, nor a token (its value is by the peg). */
function rated(currencies: Iterable<string>): string[] {
  return [...new Set([...currencies].map((code) => code.toUpperCase()))].filter((code) => /^[A-Z]{3}$/.test(code) && code !== "USD").sort();
}

/**
 * Reads the feed for each currency and stores what it gave as reference rates, once per publication. Answers the rates
 * read (with their row when stored), why each other currency has none, and whether storing was possible.
 */
export async function recordReferenceRates(
  orgDb: OrgDb,
  currencies: Iterable<string>,
  deps: { rate?: (currency: string) => Promise<UsdRate> } = {}
): Promise<{ rates: FxRate[]; failed: Record<string, string>; stored: boolean }> {
  const read = deps.rate ?? ((code: string) => usdRate(code));
  const rates: FxRate[] = [];
  const failed: Record<string, string> = {};
  for (const currency of rated(currencies)) {
    try {
      const answer = await read(currency);
      const rate = referenceRate(currency, answer.perUsd, answer.source, answer.at);
      if (rate) rates.push(rate);
      else failed[currency] = `The ${currency} rate read could not be used.`;
    } catch (error) {
      failed[currency] = error instanceof Error ? error.message : `The ${currency} rate could not be read.`;
    }
  }
  if (rates.length === 0) return { rates, failed, stored: false };
  const write = await orgDb
    .from("fx_rates")
    .upsert(
      rates.map((rate) => ({ base: rate.from, quote: rate.to, rate: rate.value, kind: "reference", source: rate.source, published_at: rate.at })),
      { onConflict: "org_id,kind,source,base,quote,published_at", ignoreDuplicates: true }
    );
  if (write.error) {
    if (notSetUp(write.error)) return { rates, failed, stored: false };
    throw new Error(`fx_rates not recorded: ${write.error.message}`);
  }
  // Each rate with its row, published once: read back, since an ignored duplicate returns nothing.
  const kept = await storedReferenceRates(orgDb, rates.map((rate) => rate.to), { since: new Date(Math.min(...rates.map((rate) => Date.parse(rate.at)))) });
  return { rates: rates.map((rate) => kept.find((row) => row.to === rate.to && row.at === rate.at && row.source === rate.source) ?? rate), failed, stored: true };
}

/** Stored reference rates of these currencies, newest first, published in `[since, until]`; none before 0113 runs. */
export async function storedReferenceRates(orgDb: OrgDb, currencies: Iterable<string>, window: { since?: Date; until?: Date } = {}): Promise<FxRate[]> {
  const codes = rated(currencies);
  if (codes.length === 0) return [];
  let query = orgDb.from("fx_rates").select(RATE_COLUMNS).eq("kind", "reference").eq("base", "USD").in("quote", codes);
  if (window.since) query = query.gte("published_at", window.since.toISOString());
  if (window.until) query = query.lte("published_at", window.until.toISOString());
  const result = await query.order("published_at", { ascending: false }).limit(500);
  if (result.error) {
    if (notSetUp(result.error)) return [];
    throw new Error(`fx_rates not read: ${result.error.message}`);
  }
  return ((result.data ?? []) as RateRow[]).map(rateOfRow).filter((rate): rate is FxRate => rate !== null);
}

/**
 * The reference rate each currency is reported at: the newest stored, published within 3 days of `now`. When one is
 * missing or older than a day, the feed is read and stored first, best effort. A currency with none says why.
 */
export async function reportingRateBook(orgDb: OrgDb, currencies: Iterable<string>, now: Date, deps: { rate?: (currency: string) => Promise<UsdRate> } = {}): Promise<RateBook> {
  const codes = rated(currencies);
  if (codes.length === 0) return rateBook([]);
  const since = new Date(now.getTime() - REPORT_RATE_MAX_AGE_MS);
  let stored = await storedReferenceRates(orgDb, codes, { since: new Date(now.getTime() - 30 * 24 * 60 * 60_000), until: now });
  const newest = (code: string) => stored.find((rate) => rate.to === code);
  const stale = codes.filter((code) => {
    const rate = newest(code);
    return !rate || now.getTime() - Date.parse(rate.at) > FRESH_MS;
  });
  let failed: Record<string, string> = {};
  let unstored: FxRate[] = [];
  if (stale.length > 0) {
    const recorded = await recordReferenceRates(orgDb, stale, deps).catch((error: unknown) => {
      console.error("fx rates not recorded", error instanceof Error ? error.message : error);
      return { rates: [] as FxRate[], failed: {} as Record<string, string>, stored: false };
    });
    failed = recorded.failed;
    // Rates read but not stored (before 0113) still count for this read, with their source and time.
    if (recorded.stored) stored = [...recorded.rates, ...stored];
    else unstored = recorded.rates;
  }
  const usable: FxRate[] = [];
  const missing: Record<string, string> = {};
  for (const code of codes) {
    const candidates = [...unstored, ...stored].filter((rate) => rate.to === code).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const best = candidates[0];
    if (best && Date.parse(best.at) >= since.getTime() && Date.parse(best.at) <= now.getTime()) usable.push(best);
    else if (best) missing[code] = `The last ${code} rate recorded was published ${rateTime(best.at)}, too old to report with.`;
    else missing[code] = failed[code] ? `No ${code} rate was recorded: ${failed[code]}` : `No ${code} rate was recorded.`;
  }
  return rateBook(usable, missing);
}

/** How many rates a person typed into a saved scenario: the KPI "manual FX adjustments". Null before 0113 runs. */
export async function countManualRates(orgDb: OrgDb = db()): Promise<number | null> {
  const result = await orgDb.from("fx_rates").select("id", { count: "exact", head: true }).eq("kind", "manual");
  if (result.error) {
    if (notSetUp(result.error)) return null;
    throw new Error(`fx_rates not counted: ${result.error.message}`);
  }
  return result.count ?? 0;
}
