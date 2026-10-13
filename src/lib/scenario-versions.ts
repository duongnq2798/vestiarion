import { z } from "zod";
import { currentOrgId } from "./context";
import { db, type OrgDb } from "./dal";
import { notSetUp } from "./fx/rates-store";
import { assertLedgerCanSign } from "./ledger";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";
import { isReportingCurrency, rateValue } from "./money";

/**
 * Saved cash scenarios (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M7): Treasury's What if levers,
 * and the exchange rates a person typed, kept as versions in `cash_scenario_versions` (0113). A version is never
 * changed: saving again is the next version of the same scenario, and a changed rate never rewrites a figure saved
 * before. Each typed rate is also a `manual` row of `fx_rates`, which the report counts as a manual FX adjustment. Each
 * save is signed `cash_scenario_saved`. Who may save (`reporting.manage`) is the command's check.
 *
 * A planning record only: nothing that decides or pays reads it, and it imports no cash scenario module, so the
 * commands that save it stay apart from the scenarios themselves (tests/cash-scenarios-ui.test.tsx).
 */

export const SCENARIO_SAVED_ACTION = "cash_scenario_saved";
export const MANUAL_RATE_SOURCE = "Cash scenario";

/** The levers as saved: the same ranges the section holds them to. */
const leversSchema = z
  .object({
    horizon: z.union([z.literal(30), z.literal(60), z.literal(90)]),
    lateDays: z.number().int().min(0).max(90),
    costPct: z.number().min(-50).max(100),
    costScope: z.enum(["all", "foreign"]),
    choices: z.record(z.string().min(1).max(100), z.enum(["late", "on_time", "never"])).refine((choices) => Object.keys(choices).length <= 500),
  })
  .strict();

export type SavedLevers = z.infer<typeof leversSchema>;

/** A rate a person typed for a currency, with the reference rate the section showed beside it, when there was one. */
export interface SavedRate {
  currency: string;
  /** How many of the currency make one US dollar, as typed. */
  perUsd: string;
  reference: { perUsd: string; source: string; at: string } | null;
}

export interface ScenarioVersion {
  id: string;
  scenarioId: string;
  version: number;
  name: string;
  levers: SavedLevers;
  rates: SavedRate[];
  reportingCurrency: string | null;
  createdBy: string | null;
  createdAt: string;
}

export type ScenarioVersionsRead = { available: false } | { available: true; versions: ScenarioVersion[] };

export type ScenarioErrorCode = "not_ready" | "name" | "levers" | "rates" | "unknown_scenario" | "changed";

export const SCENARIO_MESSAGES: Record<ScenarioErrorCode, string> = {
  not_ready: "Saving scenarios is not set up on this deployment yet.",
  name: "Name the scenario in 1 to 80 characters.",
  levers: "The scenario's levers could not be read. Set them again.",
  rates: "Type each rate as how many of the currency make one US dollar, such as 1.35.",
  unknown_scenario: "That scenario is not one of this workspace's.",
  changed: "Someone saved a newer version of this scenario. Open it, then save again.",
};

export class ScenarioVersionError extends Error {
  constructor(readonly code: ScenarioErrorCode) {
    super(SCENARIO_MESSAGES[code]);
    this.name = "ScenarioVersionError";
  }
}

const rateSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/).refine((code) => code !== "USD"),
  perUsd: z.string().max(40),
  reference: z.object({ perUsd: z.string().max(40), source: z.string().min(1).max(80), at: z.string().max(40) }).nullable(),
});

type Row = {
  id: string;
  scenario_id: string;
  version: number;
  name: string;
  levers: unknown;
  rates: unknown;
  reporting_currency: string | null;
  created_by: string | null;
  created_at: string;
};

const COLUMNS = "id, scenario_id, version, name, levers, rates, reporting_currency, created_by, created_at";

function toVersion(row: Row): ScenarioVersion | null {
  const levers = leversSchema.safeParse(row.levers);
  const rates = z.array(rateSchema).safeParse(row.rates);
  if (!levers.success || !rates.success) return null;
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    version: Number(row.version),
    name: row.name,
    levers: levers.data,
    rates: rates.data,
    reportingCurrency: row.reporting_currency,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** The newest versions first, at most 50; `available: false` before 0113 runs. */
export async function readScenarioVersions(orgDb: OrgDb = db()): Promise<ScenarioVersionsRead> {
  const result = await orgDb.from("cash_scenario_versions").select(COLUMNS).order("created_at", { ascending: false }).order("version", { ascending: false }).limit(50);
  if (result.error) {
    if (notSetUp(result.error)) return { available: false };
    throw new Error(`cash_scenario_versions not read: ${result.error.message}`);
  }
  return { available: true, versions: ((result.data ?? []) as Row[]).map(toVersion).filter((version): version is ScenarioVersion => version !== null) };
}

/** The levers and rates as sent from the section, checked; throws the first refusal. */
export function readScenarioInput(input: { name: string; levers: unknown; rates: unknown }): { name: string; levers: SavedLevers; rates: SavedRate[] } {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) throw new ScenarioVersionError("name");
  const levers = leversSchema.safeParse(input.levers);
  if (!levers.success) throw new ScenarioVersionError("levers");
  const rates = z.array(rateSchema).max(20).safeParse(input.rates);
  if (!rates.success) throw new ScenarioVersionError("rates");
  const seen = new Set<string>();
  const checked: SavedRate[] = [];
  for (const rate of rates.data) {
    const perUsd = rateValue(rate.perUsd);
    if (perUsd === null || seen.has(rate.currency)) throw new ScenarioVersionError("rates");
    seen.add(rate.currency);
    const reference = rate.reference ? { ...rate.reference, perUsd: rateValue(rate.reference.perUsd) ?? "" } : null;
    checked.push({ currency: rate.currency, perUsd, reference: reference && reference.perUsd && !Number.isNaN(Date.parse(reference.at)) ? reference : null });
  }
  return { name, levers: levers.data, rates: checked };
}

export async function saveScenarioVersion(input: {
  actorId: string;
  scenarioId: string | null;
  name: string;
  levers: unknown;
  rates: unknown;
  reportingCurrency: string | null;
  newId?: () => string;
}): Promise<ScenarioVersion> {
  const { name, levers, rates } = readScenarioInput(input);
  const orgDb = db();
  let scenarioId = input.scenarioId;
  let version = 1;
  if (scenarioId) {
    const last = await orgDb.from("cash_scenario_versions").select("version").eq("scenario_id", scenarioId).order("version", { ascending: false }).limit(1);
    if (last.error) {
      if (notSetUp(last.error)) throw new ScenarioVersionError("not_ready");
      throw new Error(`cash_scenario_versions not read: ${last.error.message}`);
    }
    const newest = ((last.data ?? []) as Array<{ version: number }>)[0];
    if (!newest) throw new ScenarioVersionError("unknown_scenario");
    version = Number(newest.version) + 1;
  } else {
    scenarioId = (input.newId ?? (() => crypto.randomUUID()))();
  }
  // An unreadable signing key refuses the save before it is written, rather than leave it unsigned.
  assertLedgerCanSign();

  const reportingCurrency = input.reportingCurrency && isReportingCurrency(input.reportingCurrency) ? input.reportingCurrency : null;
  const write = await orgDb
    .from("cash_scenario_versions")
    .insert({ scenario_id: scenarioId, version, name, levers, rates, reporting_currency: reportingCurrency, created_by: input.actorId })
    .select(COLUMNS)
    .single<Row>();
  if (write.error) {
    if (notSetUp(write.error)) throw new ScenarioVersionError("not_ready");
    // Someone saved the same number first, or the scenario moved on: never written over.
    if (write.error.code === "23505" || /cash_scenario_(started|version_gap)/.test(write.error.message ?? "")) throw new ScenarioVersionError("changed");
    throw new Error(`cash_scenario_versions not written: ${write.error.message}`);
  }
  const saved = toVersion(write.data);
  if (!saved) throw new Error("cash_scenario_versions wrote a row it cannot read");

  // Each typed rate as a manual FX adjustment, named by its version. Best effort: the version holds its rates either way.
  if (rates.length > 0) {
    const kept = await orgDb.from("fx_rates").insert(
      rates.map((rate) => ({
        base: "USD",
        quote: rate.currency,
        rate: rate.perUsd,
        kind: "manual",
        source: MANUAL_RATE_SOURCE,
        published_at: saved.createdAt,
        recorded_by: input.actorId,
        scenario_version_id: saved.id,
      }))
    );
    if (kept.error) console.error("scenario rates not recorded", currentOrgId(), kept.error.code ?? "error");
  }

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "treasury",
    action: SCENARIO_SAVED_ACTION,
    summary: `Saved version ${version} of the cash scenario "${name}"${rates.length > 0 ? `, with ${rates.length === 1 ? "a rate" : `${rates.length} rates`} typed` : ""}`,
    detail: {
      by: input.actorId,
      scenarioId,
      versionId: saved.id,
      version,
      name,
      horizon: levers.horizon,
      lateDays: levers.lateDays,
      costPct: levers.costPct,
      costScope: levers.costScope,
      receivablesChanged: Object.keys(levers.choices).length,
      rates: rates.map((rate) => ({ currency: rate.currency, perUsd: rate.perUsd, reference: rate.reference })),
      reportingCurrency,
    },
  });
  return saved;
}
