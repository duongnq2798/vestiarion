import { supabase, unwrap } from "./supabase";
import { appendLedgerEntry } from "./ledger";

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
 * `simulated-sanctions-list` is a small bundled watchlist standing in for a
 * self-hosted opensanctions/yente instance or Circle's Compliance Engine.
 * Replace `screenName` with a real lookup and nothing downstream changes —
 * the risk tiering and limit arithmetic are independent of the source.
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
}

export function screenName(name: string): ScreeningResult {
  for (const entry of WATCHLIST) {
    if (entry.pattern.test(name)) {
      return {
        riskLevel: entry.level,
        notes: entry.notes,
        source: "simulated-sanctions-list",
      };
    }
  }
  return {
    riskLevel: "clear",
    notes: "No match against watchlist",
    source: "simulated-sanctions-list",
  };
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

/** How long a screening stays fresh. 0 — the default — re-screens every cycle. */
export function rescreenIntervalMs(): number {
  const hours = Number(process.env.COMPLIANCE_RESCREEN_HOURS ?? 0);
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
}

const toNum = (v: string | number | null) => (v == null ? null : Number(v));

const SCREENING_COLUMNS =
  "id, name, risk_level, payment_limit, baseline_payment_limit, last_screened_at";

/**
 * Decides what a screen should write, without touching the database. The
 * tiering rules are the part worth testing exhaustively, and keeping them
 * pure means a test can screen the same counterparty fifty times and assert
 * the limit never moves.
 */
export function planScreening(cp: CounterpartyScreeningRow): {
  result: ScreeningResult;
  baseline: number | null;
  previousLimit: number | null;
  newLimit: number | null;
  changed: boolean;
  firstScreen: boolean;
} {
  const result = screenName(cp.name);

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
  return applyScreening(cp);
}

/**
 * Screens one already-loaded row. Split out so a sweep can screen the whole
 * book from a single select rather than one round trip per counterparty.
 */
async function applyScreening(cp: CounterpartyScreeningRow): Promise<ScreeningOutcome> {
  const db = supabase();
  const plan = planScreening(cp);
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
  for (const row of due) screened.push(await applyScreening(row));

  const changes = screened.filter((s) => s.changed);
  await appendLedgerEntry({
    actor: "agent",
    domain: "compliance",
    action: "compliance_sweep",
    summary: `Re-screened ${screened.length} of ${rows.length} counterparties; ${changes.length} changed`,
    detail: {
      source: "simulated-sanctions-list",
      rescreenIntervalHours: interval / 3_600_000,
      screened: screened.map((s) => ({
        name: s.name,
        riskLevel: s.riskLevel,
        changed: s.changed,
      })),
      skipped: rows.length - screened.length,
    },
  });

  return { screened, skipped: rows.length - screened.length };
}
