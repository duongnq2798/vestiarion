import { supabase, unwrap } from "./supabase";
import { appendLedgerEntry } from "./ledger";
import { z } from "zod";
import {
  COUNTERPARTY_HISTORY_ACTIONS,
  deriveCounterpartyHistories,
  derivePerformanceScore,
  emptyCounterpartyHistory,
  isMaterialPerformanceChange,
  PERFORMANCE_SCORE_MATERIAL_DELTA,
  type CounterpartyHistoryInputs,
  type CounterpartyHistoryLedgerEntry,
} from "./agent/counterparty-history";

/**
 * RFB5 — continuous compliance, not a one-time gate. Every counterparty is
 * re-screened on a cadence rather than once at onboarding, and a hit produces
 * a risk *tier* with a reduced payment limit instead of a blunt yes/no. That
 * is the "Megarian Decree" problem from the brief: a static list is out of
 * date the moment it is carved.
 *
 * Re-screening is only safe because tiering is idempotent. The limit the
 * business configured lives in `baseline_payment_limit` and screening never
 * writes to it; `payment_limit` is derived from the baseline on every screen.
 * Without that split, screening a medium-risk counterparty twice would leave
 * it on 6.25% of its limit — see supabase/migrations/0002.
 *
 * `screenName` is the provider boundary. It calls OpenSanctions/yente when a
 * URL is configured and otherwise uses the bundled watchlist. Tiering and
 * limit arithmetic below are independent of that source.
 */

const WATCHLIST: Array<{ pattern: RegExp; level: "high" | "medium"; notes: string }> = [
  {
    pattern: /zenith trading/i,
    level: "high",
    notes: "Name matches a shell-entity pattern on the demo watchlist",
  },
  {
    pattern: /wardrobe holdings/i,
    level: "medium",
    notes: "Recently registered counterparty with no transaction history",
  },
];

export interface ScreeningResult {
  riskLevel: "clear" | "medium" | "high";
  notes: string;
  source: string;
  screeningMode: "live" | "simulate";
  rawScore: number | null;
  matchedEntityId: string | null;
  matchedTopics: string[];
}

export const STRONG_SANCTIONS_MATCH_THRESHOLD = 0.85;

export function screeningMode(): "live" | "simulate" {
  return process.env.OPENSANCTIONS_API_URL ? "live" : "simulate";
}

export function screenBundledName(name: string): ScreeningResult {
  for (const entry of WATCHLIST) {
    if (entry.pattern.test(name)) {
      return {
        riskLevel: entry.level,
        notes: entry.notes,
        source: "simulated-sanctions-list",
        screeningMode: "simulate",
        rawScore: null,
        matchedEntityId: null,
        matchedTopics: [],
      };
    }
  }
  return {
    riskLevel: "clear",
    notes: "No match against watchlist",
    source: "simulated-sanctions-list",
    screeningMode: "simulate",
    rawScore: null,
    matchedEntityId: null,
    matchedTopics: [],
  };
}

const openSanctionsMatchSchema = z.object({
  responses: z.record(z.string(), z.object({
    status: z.number(),
    results: z.array(z.object({
      id: z.string(),
      caption: z.string().optional(),
      score: z.number().min(0).max(1),
      target: z.boolean().optional(),
      properties: z.record(z.string(), z.array(z.string())).default({}),
    })),
  })),
});

type OpenSanctionsCandidate = z.infer<typeof openSanctionsMatchSchema>["responses"][string]["results"][number];

export function classifyOpenSanctionsCandidate(candidate: OpenSanctionsCandidate | undefined): ScreeningResult {
  if (!candidate) {
    return {
      riskLevel: "clear",
      notes: "OpenSanctions returned no matching entity",
      source: "opensanctions:yente",
      screeningMode: "live",
      rawScore: null,
      matchedEntityId: null,
      matchedTopics: [],
    };
  }

  const topics = candidate.properties.topics ?? [];
  const sanctionsHit = topics.some((topic) => topic === "sanction" || topic.startsWith("sanction."));
  // 0.85 is deliberately above yente's 0.70 default match cutoff: a high
  // tier removes payment authority, so fuzzy sanctions matches stay medium
  // for review while a strong same-entity match fails closed at high.
  const riskLevel = sanctionsHit && candidate.score >= STRONG_SANCTIONS_MATCH_THRESHOLD ? "high" : "medium";
  return {
    riskLevel,
    notes: `${candidate.caption ?? candidate.id} matched at ${candidate.score.toFixed(3)}${topics.length ? ` (${topics.join(", ")})` : ""}`,
    source: "opensanctions:yente",
    screeningMode: "live",
    rawScore: candidate.score,
    matchedEntityId: candidate.id,
    matchedTopics: topics,
  };
}

function matchEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/match\/[^/]+$/.test(trimmed) ? trimmed : `${trimmed}/match/default`;
}

export async function screenName(name: string, jurisdiction?: string | null): Promise<ScreeningResult> {
  const baseUrl = process.env.OPENSANCTIONS_API_URL;
  if (!baseUrl) return screenBundledName(name);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.OPENSANCTIONS_API_KEY) {
    headers.Authorization = `ApiKey ${process.env.OPENSANCTIONS_API_KEY}`;
  }

  const response = await fetch(matchEndpoint(baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      queries: {
        counterparty: {
          schema: "LegalEntity",
          properties: {
            name: [name],
            ...(jurisdiction ? { jurisdiction: [jurisdiction] } : {}),
          },
        },
      },
    }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`OpenSanctions screening failed with HTTP ${response.status}`);

  const parsed = openSanctionsMatchSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("OpenSanctions returned an invalid match response");
  const query = parsed.data.responses.counterparty;
  if (!query || query.status >= 400) throw new Error(`OpenSanctions query failed with status ${query?.status ?? "missing"}`);
  return classifyOpenSanctionsCandidate(query.results[0]);
}

/**
 * A medium-risk counterparty keeps a reduced limit rather than being cut
 * off; a high-risk one drops to zero, which the orchestrator enforces as a
 * hard block before any transfer is attempted.
 *
 * A null baseline means no limit was ever configured — typically a customer
 * we invoice rather than pay. Screening leaves that null instead of
 * inventing a number, except when risk is high, where an explicit zero is
 * the point.
 *
 * This must stay a pure function of (risk, baseline). Applying it to its own
 * output is exactly what broke re-screening before migration 0002.
 */
export function paymentLimitForRisk(risk: string, baseline: number | null): number | null {
  if (risk === "high") return 0;
  if (baseline == null) return null;
  if (risk === "medium") return Number((baseline * 0.25).toFixed(6));
  return baseline;
}

/** Live screening defaults to daily; the zero-credential demo re-screens every cycle. */
export function rescreenIntervalMs(): number {
  const hours = Number(process.env.COMPLIANCE_RESCREEN_HOURS ?? (screeningMode() === "live" ? 24 : 0));
  return Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : 0;
}

export function isScreeningDue(
  row: { risk_level: string; last_screened_at: string | null },
  now: number,
  intervalMs: number
): boolean {
  if (row.risk_level === "unscreened" || !row.last_screened_at) return true;
  if (intervalMs === 0) return true;
  return now - Date.parse(row.last_screened_at) >= intervalMs;
}

export interface ScreeningOutcome extends ScreeningResult {
  counterpartyId: string;
  name: string;
  previousRiskLevel: string;
  previousPaymentLimit: number | null;
  newPaymentLimit: number | null;
  /** First screen, or a change in tier or effective limit since the last one. */
  changed: boolean;
  firstScreen: boolean;
}

export interface CounterpartyScreeningRow {
  id: string;
  name: string;
  risk_level: string;
  payment_limit: string | number | null;
  baseline_payment_limit: string | number | null;
  last_screened_at: string | null;
  jurisdiction?: string | null;
  performance_score?: string | number | null;
  performance_inputs?: CounterpartyHistoryInputs | null;
}

const toNum = (v: string | number | null) => (v == null ? null : Number(v));

const SCREENING_COLUMNS =
  "id, name, risk_level, payment_limit, baseline_payment_limit, last_screened_at, jurisdiction, performance_score, performance_inputs";

/**
 * Decides what a screen should write, without touching the database. The
 * tiering rules are the part worth testing exhaustively, and keeping them
 * pure means a test can screen the same counterparty fifty times and assert
 * the limit never moves.
 */
export function planScreening(cp: CounterpartyScreeningRow, result = screenBundledName(cp.name)): {
  result: ScreeningResult;
  baseline: number | null;
  previousLimit: number | null;
  newLimit: number | null;
  changed: boolean;
  firstScreen: boolean;
} {
  // On a counterparty that predates migration 0002 — or one inserted by hand
  // without a baseline — the current limit *is* the configured limit, because
  // no tiering has been applied to it yet. Capture it once, then never again.
  const firstScreen = cp.risk_level === "unscreened" || cp.last_screened_at == null;
  const baseline =
    toNum(cp.baseline_payment_limit) ?? (firstScreen ? toNum(cp.payment_limit) : null);

  const previousLimit = toNum(cp.payment_limit);
  const newLimit = paymentLimitForRisk(result.riskLevel, baseline);
  const changed =
    firstScreen || result.riskLevel !== cp.risk_level || newLimit !== previousLimit;

  return { result, baseline, previousLimit, newLimit, changed, firstScreen };
}

export async function screenCounterparty(counterpartyId: string): Promise<ScreeningOutcome> {
  const db = supabase();
  const cp = unwrap(
    await db
      .from("counterparties")
      .select(SCREENING_COLUMNS)
      .eq("id", counterpartyId)
      .single<CounterpartyScreeningRow>()
  );
  try {
    return await applyScreening(cp);
  } catch (error) {
    if (!(error instanceof ScreeningLookupError)) throw error;
    await recordScreeningFailure(cp, error.message, true);
    throw error;
  }
}

/**
 * Screens one already-loaded row. Split out so a sweep can screen the whole
 * book from a single select rather than one round trip per counterparty.
 */
async function applyScreening(cp: CounterpartyScreeningRow): Promise<ScreeningOutcome> {
  const db = supabase();
  let result: ScreeningResult;
  try {
    result = await screenName(cp.name, cp.jurisdiction);
  } catch (error) {
    throw new ScreeningLookupError(error instanceof Error ? error.message : "Unknown screening failure");
  }
  const plan = planScreening(cp, result);
  const now = new Date().toISOString();

  const update = await db
    .from("counterparties")
    .update({
      risk_level: plan.result.riskLevel,
      risk_notes: plan.result.notes,
      last_screened_at: now,
      baseline_payment_limit: plan.baseline,
      payment_limit: plan.newLimit,
    })
    .eq("id", cp.id);
  if (update.error) throw new Error(update.error.message);

  const insert = await db.from("compliance_checks").insert({
    counterparty_id: cp.id,
    risk_level: plan.result.riskLevel,
    source: plan.result.source,
    notes: plan.result.notes,
    raw_score: plan.result.rawScore,
    matched_entity_id: plan.result.matchedEntityId,
    screening_mode: plan.result.screeningMode,
    status: "complete",
  });
  if (insert.error) throw new Error(insert.error.message);

  const outcome: ScreeningOutcome = {
    ...plan.result,
    counterpartyId: cp.id,
    name: cp.name,
    previousRiskLevel: cp.risk_level,
    previousPaymentLimit: plan.previousLimit,
    newPaymentLimit: plan.newLimit,
    changed: plan.changed,
    firstScreen: plan.firstScreen,
  };

  // A re-screen that finds nothing new is recorded in `compliance_checks` and
  // counted in the sweep entry, but does not get its own ledger entry: six
  // unchanged counterparties every cycle would bury the one that moved. A
  // tier change is the opposite — it is the event an auditor is looking for.
  if (plan.changed) {
    await appendLedgerEntry({
      actor: "agent",
      domain: "compliance",
      action: plan.firstScreen ? "screen_counterparty" : "risk_level_changed",
      summary: plan.firstScreen
        ? `Screened ${cp.name}: ${plan.result.riskLevel} risk`
        : `${cp.name} risk ${cp.risk_level} → ${plan.result.riskLevel}, limit ${plan.previousLimit ?? "none"} → ${plan.newLimit ?? "none"} USDC`,
      detail: {
        counterpartyId: cp.id,
        counterpartyName: cp.name,
        riskLevel: plan.result.riskLevel,
        previousRiskLevel: cp.risk_level,
        notes: plan.result.notes,
        source: plan.result.source,
        screeningMode: plan.result.screeningMode,
        rawScore: plan.result.rawScore,
        matchedEntityId: plan.result.matchedEntityId,
        matchedTopics: plan.result.matchedTopics,
        baselinePaymentLimit: plan.baseline,
        previousPaymentLimit: plan.previousLimit,
        newPaymentLimit: plan.newLimit,
      },
    });
  }

  return outcome;
}

export interface SweepResult {
  screened: ScreeningOutcome[];
  skipped: number;
  failures: Array<{ counterpartyId: string; name: string; error: string }>;
  performance: CounterpartyPerformanceOutcome[];
  complete: boolean;
}

export interface CounterpartyPerformanceOutcome {
  counterpartyId: string;
  name: string;
  previousScore: number | null;
  score: number | null;
  observations: number;
  inputs: CounterpartyHistoryInputs;
  materiallyChanged: boolean;
}

class ScreeningLookupError extends Error {}

const HISTORY_LEDGER_PAGE_SIZE = 1_000;

async function listCounterpartyHistoryEntries(): Promise<CounterpartyHistoryLedgerEntry[]> {
  const db = supabase();
  const entries: CounterpartyHistoryLedgerEntry[] = [];
  let afterSequence = 0;

  while (true) {
    const page = unwrap(
      await db
        .from("ledger_entries")
        .select("seq, domain, action, detail")
        .in("action", [...COUNTERPARTY_HISTORY_ACTIONS])
        .gt("seq", afterSequence)
        .order("seq", { ascending: true })
        .limit(HISTORY_LEDGER_PAGE_SIZE)
    ) as Array<CounterpartyHistoryLedgerEntry & { seq: number }>;
    entries.push(...page);
    if (page.length < HISTORY_LEDGER_PAGE_SIZE) break;
    afterSequence = page.at(-1)!.seq;
  }

  return entries;
}

async function refreshCounterpartyPerformance(
  rows: CounterpartyScreeningRow[]
): Promise<CounterpartyPerformanceOutcome[]> {
  const db = supabase();
  const [invoiceRows, milestoneRows, ledgerEntries] = await Promise.all([
    db.from("invoices").select("id, counterparty_id"),
    db.from("milestones").select("id, contractor_id"),
    listCounterpartyHistoryEntries(),
  ]);
  if (invoiceRows.error) throw new Error(invoiceRows.error.message);
  if (milestoneRows.error) throw new Error(milestoneRows.error.message);

  const histories = deriveCounterpartyHistories(ledgerEntries, {
    invoiceCounterparty: new Map(
      (invoiceRows.data as Array<{ id: string; counterparty_id: string }>).map((row) => [
        row.id,
        row.counterparty_id,
      ])
    ),
    milestoneCounterparty: new Map(
      (milestoneRows.data as Array<{ id: string; contractor_id: string }>).map((row) => [
        row.id,
        row.contractor_id,
      ])
    ),
  });

  const outcomes: CounterpartyPerformanceOutcome[] = [];
  for (const row of rows) {
    const performance = derivePerformanceScore(
      histories.get(row.id) ?? emptyCounterpartyHistory()
    );
    const previousScore = toNum(row.performance_score ?? null);
    const materiallyChanged = isMaterialPerformanceChange(previousScore, performance.score);
    const update = await db
      .from("counterparties")
      .update({
        performance_score: performance.score,
        performance_inputs: performance.inputs,
      })
      .eq("id", row.id);
    if (update.error) throw new Error(update.error.message);

    const outcome = {
      counterpartyId: row.id,
      name: row.name,
      previousScore,
      score: performance.score,
      observations: performance.observations,
      inputs: performance.inputs,
      materiallyChanged,
    };
    outcomes.push(outcome);

    if (materiallyChanged) {
      const before = previousScore == null ? "no history" : previousScore.toFixed(3);
      const after = performance.score == null ? "no history" : performance.score.toFixed(3);
      await appendLedgerEntry({
        actor: "agent",
        domain: "compliance",
        action: "performance_score_changed",
        summary: `${row.name} performance history ${before} → ${after}`,
        detail: {
          counterpartyId: row.id,
          counterpartyName: row.name,
          previousScore,
          performanceScore: performance.score,
          observations: performance.observations,
          inputs: performance.inputs,
          materialDelta: PERFORMANCE_SCORE_MATERIAL_DELTA,
          evidenceOnly: true,
        },
      });
    }
  }

  return outcomes;
}

async function recordScreeningFailure(
  row: CounterpartyScreeningRow,
  message: string,
  writeLedgerEntry = false
): Promise<void> {
  const failureCheck = await supabase().from("compliance_checks").insert({
    counterparty_id: row.id,
    risk_level: row.risk_level,
    source: screeningMode() === "live" ? "opensanctions:yente" : "simulated-sanctions-list",
    notes: message,
    screening_mode: screeningMode(),
    status: "failed",
  });
  if (failureCheck.error) throw new Error(failureCheck.error.message);

  if (writeLedgerEntry) {
    await appendLedgerEntry({
      actor: "agent",
      domain: "compliance",
      action: "screening_incomplete",
      summary: `Screening incomplete for ${row.name}; previous verdict retained`,
      detail: {
        counterpartyId: row.id,
        counterpartyName: row.name,
        previousRiskLevel: row.risk_level,
        previousLastScreenedAt: row.last_screened_at,
        screeningMode: screeningMode(),
        complete: false,
        error: message,
      },
    });
  }
}

/**
 * One pass over the whole counterparty book. Every counterparty whose
 * screening has gone stale is re-checked, and the sweep itself is logged — so
 * the ledger proves screening *happened* on a given cycle, not merely that
 * nothing changed. Proof of absence is the part a one-time gate cannot give.
 */
export async function runComplianceSweep(): Promise<SweepResult> {
  const db = supabase();
  const rows = unwrap(
    await db.from("counterparties").select(SCREENING_COLUMNS).order("name")
  ) as CounterpartyScreeningRow[];

  const interval = rescreenIntervalMs();
  const now = Date.now();
  const due = rows.filter((r) => isScreeningDue(r, now, interval));

  const screened: ScreeningOutcome[] = [];
  const failures: SweepResult["failures"] = [];
  for (const row of due) {
    try {
      screened.push(await applyScreening(row));
    } catch (error) {
      if (!(error instanceof ScreeningLookupError)) throw error;
      const message = error instanceof Error ? error.message : "Unknown screening failure";
      failures.push({ counterpartyId: row.id, name: row.name, error: message });

      // Preserve the previous counterparty verdict and timestamp. This check
      // records the outage itself without pretending it produced a new tier.
      await recordScreeningFailure(row, message);
    }
  }

  const changes = screened.filter((s) => s.changed);
  const performance = await refreshCounterpartyPerformance(rows);
  const complete = failures.length === 0;
  await appendLedgerEntry({
    actor: "agent",
    domain: "compliance",
    action: "compliance_sweep",
    summary: complete
      ? `Re-screened ${screened.length} of ${rows.length} counterparties; ${changes.length} changed`
      : `Screening incomplete: ${failures.length} of ${due.length} due checks failed; previous verdicts retained`,
    detail: {
      source: screeningMode() === "live" ? "opensanctions:yente" : "simulated-sanctions-list",
      screeningMode: screeningMode(),
      complete,
      rescreenIntervalHours: interval / 3_600_000,
      screened: screened.map((s) => ({
        name: s.name,
        riskLevel: s.riskLevel,
        changed: s.changed,
        rawScore: s.rawScore,
        matchedEntityId: s.matchedEntityId,
      })),
      failures,
      skipped: rows.length - screened.length,
      performance: performance.map((result) => ({
        counterpartyId: result.counterpartyId,
        score: result.score,
        observations: result.observations,
        inputs: result.inputs,
        materiallyChanged: result.materiallyChanged,
      })),
    },
  });

  return { screened, skipped: rows.length - due.length, failures, performance, complete };
}
