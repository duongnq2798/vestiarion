import { db, platformDb, unwrap, type OrgDb } from "../dal";
import { withOrg } from "../dal/scope";
import { readReportingCurrency } from "../reporting-currency";
import { readShadowMode } from "../shadow-mode";
import { notSetUp, recordReferenceRates } from "./rates-store";
import { usdRate, type UsdRate } from "./usd-rates";
import { recordFxVariances } from "./variances";

/**
 * The hourly rates job (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M5, M6), run by
 * `POST /api/platform/fx-rates` from Supabase Cron. In each workspace with a reporting currency, shadow mode in a
 * currency of its own, or bills converted at a rate, it records the feed's reference rate for those currencies (once
 * per publication: the feed publishes daily), then records the FX variance of every paid bill whose payment-day rate is
 * now recorded. So a payment made at any hour finds the rate that was in force, whoever opens a page.
 *
 * Each workspace runs in its own scope, one after another, and one's failure is its own. It reads and writes only rates
 * and variances: nothing that decides or pays. Before migration 0113 runs, it has nothing to do. This job is the only
 * reader of the feed and the only writer of reference rates and variances: no page reads the feed or writes either.
 *
 * A feed that does not answer is asked once a run, not again for each workspace: the rest of the run records the
 * variances the rates already stored allow, and the next hour asks again.
 */

export interface RatesJobResult {
  /** Workspaces that needed a rate. */
  workspaces: number;
  /** Rates read from the feed and stored (a publication already stored counts once, when first stored). */
  rates: number;
  /** Variances recorded in all. */
  variances: number;
  /** Workspaces whose run failed. */
  failed: number;
  /** Workspaces not reached within the run's time. */
  skipped: number;
}

/**
 * The currencies a workspace needs a reference rate for, or none when it needs none: since no page reads the feed,
 * every currency a page converts. Bills' own currencies (their variances, Treasury's rates, the report), the shadow
 * mode's, and with a reporting currency set, it and every other currency the report converts into it: what the
 * business recorded paying in, and the euro, which EURC reaches by its peg.
 */
async function currenciesOf(orgDb: OrgDb): Promise<string[] | null> {
  const [reporting, shadow, bills] = await Promise.all([
    readReportingCurrency(orgDb),
    readShadowMode(orgDb),
    orgDb.from("invoices").select("original_currency").eq("direction", "payable").not("original_currency", "is", null).neq("status", "rejected").limit(1000),
  ]);
  if (!reporting.available) return null;
  if (bills.error) throw new Error(`invoices not read: ${bills.error.message}`);
  const codes = new Set<string>();
  if (shadow && shadow.currency !== "USDC") codes.add(shadow.currency);
  for (const row of (bills.data ?? []) as Array<{ original_currency: string | null }>) if (row.original_currency) codes.add(row.original_currency);
  if (reporting.setting) {
    codes.add(reporting.setting.currency);
    const [paid, eurc] = await Promise.all([
      orgDb.from("payment_actuals").select("currency").not("currency", "is", null).limit(1000),
      orgDb.from("invoices").select("currency").eq("currency", "EURC").limit(1),
    ]);
    if (paid.error && !notSetUp(paid.error)) throw new Error(`payment_actuals not read: ${paid.error.message}`);
    if (eurc.error) throw new Error(`invoices not read: ${eurc.error.message}`);
    for (const row of (paid.data ?? []) as Array<{ currency: string | null }>) if (row.currency && row.currency !== "USDC" && row.currency !== "EURC") codes.add(row.currency);
    if ((eurc.data ?? []).length > 0) codes.add("EUR");
  }
  codes.delete("USD");
  return [...codes].sort();
}

export async function recordRatesForWorkspaces(deps: { now?: () => number; budgetMs?: number; rate?: (currency: string) => Promise<UsdRate> } = {}): Promise<RatesJobResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const budget = deps.budgetMs ?? 240_000;
  const orgs = unwrap(await platformDb().from("orgs").select("id").order("id")) as Array<{ id: string }>;
  const result: RatesJobResult = { workspaces: 0, rates: 0, variances: 0, failed: 0, skipped: 0 };
  const feed = deps.rate ?? ((currency: string) => usdRate(currency));
  // The feed answers every currency in one read: once it has failed, this run asks it nothing more. A currency it does
  // not list is that currency's alone.
  let down: unknown = null;
  const rate = async (currency: string): Promise<UsdRate> => {
    if (down) throw down;
    try {
      return await feed(currency);
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("There is no rate for "))) down = error;
      throw error;
    }
  };
  for (const [index, org] of orgs.entries()) {
    if (now() - started > budget) {
      result.skipped = orgs.length - index;
      break;
    }
    try {
      await withOrg(org.id, async () => {
        const orgDb = db();
        const currencies = await currenciesOf(orgDb);
        if (!currencies || currencies.length === 0) return;
        result.workspaces += 1;
        const recorded = await recordReferenceRates(orgDb, currencies, { rate });
        if (recorded.stored) result.rates += recorded.rates.length;
        const variances = await recordFxVariances(orgDb);
        if (variances.available) result.variances += variances.recorded.length;
      });
    } catch (error) {
      result.failed += 1;
      // The workspace by id only, never its name or a figure: the route's answer reaches a public workflow log.
      const message = error && typeof error === "object" && "code" in error && notSetUp(error as { code?: string }) ? "not set up" : error instanceof Error ? error.message : "unknown error";
      console.error("fx rates job failed for a workspace", org.id, message);
    }
  }
  return result;
}
