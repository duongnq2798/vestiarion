import { db, platformDb, unwrap, type OrgDb } from "../dal";
import { withOrg } from "../dal/scope";
import { readReportingCurrency } from "../reporting-currency";
import { readShadowMode } from "../shadow-mode";
import { notSetUp, recordReferenceRates } from "./rates-store";
import type { UsdRate } from "./usd-rates";
import { recordFxVariances } from "./variances";

/**
 * The hourly rates job (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M5, M6), run by
 * `POST /api/platform/fx-rates` from Supabase Cron. In each workspace with a reporting currency, shadow mode in a
 * currency of its own, or bills converted at a rate, it records the feed's reference rate for those currencies (once
 * per publication: the feed publishes daily), then records the FX variance of every paid bill whose payment-day rate is
 * now recorded. So a payment made at any hour finds the rate that was in force, whoever opens a page.
 *
 * Each workspace runs in its own scope, one after another, and one's failure is its own. It reads and writes only rates
 * and variances: nothing that decides or pays. Before migration 0113 runs, it has nothing to do.
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

/** The currencies a workspace needs a reference rate for, or none when it needs none. */
async function currenciesOf(orgDb: OrgDb): Promise<string[] | null> {
  const [reporting, shadow, bills] = await Promise.all([
    readReportingCurrency(orgDb),
    readShadowMode(orgDb),
    orgDb.from("invoices").select("original_currency").eq("direction", "payable").not("original_currency", "is", null).neq("status", "rejected").limit(1000),
  ]);
  if (!reporting.available) return null;
  if (bills.error) throw new Error(`invoices not read: ${bills.error.message}`);
  const codes = new Set<string>();
  if (reporting.setting) codes.add(reporting.setting.currency);
  if (shadow && shadow.currency !== "USDC") codes.add(shadow.currency);
  for (const row of (bills.data ?? []) as Array<{ original_currency: string | null }>) if (row.original_currency) codes.add(row.original_currency);
  codes.delete("USD");
  return [...codes].sort();
}

export async function recordRatesForWorkspaces(deps: { now?: () => number; budgetMs?: number; rate?: (currency: string) => Promise<UsdRate> } = {}): Promise<RatesJobResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const budget = deps.budgetMs ?? 240_000;
  const orgs = unwrap(await platformDb().from("orgs").select("id").order("id")) as Array<{ id: string }>;
  const result: RatesJobResult = { workspaces: 0, rates: 0, variances: 0, failed: 0, skipped: 0 };
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
        const recorded = await recordReferenceRates(orgDb, currencies, deps.rate ? { rate: deps.rate } : {});
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
