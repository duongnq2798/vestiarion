import { supabase, unwrap } from "./supabase";
import { appendLedgerEntry } from "./ledger";

/**
 * RFB5 — continuous compliance, not a one-time gate. Every counterparty is
 * re-screened on each agent cycle rather than once at onboarding, and a hit
 * produces a risk *tier* with a reduced payment limit instead of a blunt
 * yes/no. That is the "Megarian Decree" problem from the brief: a static
 * list is out of date the moment it is carved.
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
 */
export function paymentLimitForRisk(risk: string, baseline: number | null): number | null {
  if (risk === "high") return 0;
  if (baseline == null) return null;
  if (risk === "medium") return baseline * 0.25;
  return baseline;
}

export async function screenCounterparty(counterpartyId: string): Promise<ScreeningResult> {
  const db = supabase();

  const cp = unwrap(
    await db
      .from("counterparties")
      .select("id, name, payment_limit")
      .eq("id", counterpartyId)
      .single<{ id: string; name: string; payment_limit: string | null }>()
  );

  const result = screenName(cp.name);
  const baseline = cp.payment_limit == null ? null : Number(cp.payment_limit);
  const newLimit = paymentLimitForRisk(result.riskLevel, baseline);
  const now = new Date().toISOString();

  const update = await db
    .from("counterparties")
    .update({
      risk_level: result.riskLevel,
      risk_notes: result.notes,
      last_screened_at: now,
      payment_limit: newLimit,
    })
    .eq("id", cp.id);
  if (update.error) throw new Error(update.error.message);

  const insert = await db.from("compliance_checks").insert({
    counterparty_id: cp.id,
    risk_level: result.riskLevel,
    source: result.source,
    notes: result.notes,
  });
  if (insert.error) throw new Error(insert.error.message);

  await appendLedgerEntry({
    actor: "agent",
    domain: "compliance",
    action: "screen_counterparty",
    summary: `Screened ${cp.name}: ${result.riskLevel} risk`,
    detail: {
      counterpartyId: cp.id,
      counterpartyName: cp.name,
      riskLevel: result.riskLevel,
      notes: result.notes,
      source: result.source,
      previousPaymentLimit: baseline,
      newPaymentLimit: newLimit,
    },
  });

  return result;
}
