import { supabase, unwrap } from "./supabase";

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

export interface LandingMetrics {
  instrumentedCycles: number;
  instrumentedDecisions: number;
  settledLiveTransfers: number;
  medianChainFeeUsd: number | null;
  chainFeeSampleCount: number;
  medianSettlementMs: number | null;
  settlementSampleCount: number;
  ledgerHeight: number;
  latestInstrumentedCycleAt: string | null;
}

/** Server-only source for every number rendered as a landing-page metric. */
export async function getLandingMetrics(): Promise<LandingMetrics> {
  const db = supabase();
  const [runsResult, transfersResult, ledgerResult] = await Promise.all([
    db.from("cycle_runs").select("decision_count, finished_at").order("finished_at", { ascending: true }),
    db
      .from("payment_intents")
      .select("fee_usd, fee_source, settled_in_ms")
      .eq("provider_mode", "live")
      .eq("status", "confirmed")
      .not("executed_at", "is", null),
    db.from("ledger_entries").select("*", { count: "exact", head: true }),
  ]);

  const runs = unwrap(runsResult) as Array<{ decision_count: number; finished_at: string }>;
  const transfers = unwrap(transfersResult) as Array<{
    fee_usd: string | number | null;
    fee_source: string | null;
    settled_in_ms: string | number | null;
  }>;
  if (ledgerResult.error) throw new Error(ledgerResult.error.message);

  const chainFees = transfers
    .filter((row) => row.fee_source === "chain_reported" && row.fee_usd != null)
    .map((row) => Number(row.fee_usd))
    .filter(Number.isFinite);
  const settlementTimes = transfers
    .filter((row) => row.settled_in_ms != null)
    .map((row) => Number(row.settled_in_ms))
    .filter(Number.isFinite);

  return {
    instrumentedCycles: runs.length,
    instrumentedDecisions: runs.reduce((sum, row) => sum + row.decision_count, 0),
    settledLiveTransfers: transfers.length,
    medianChainFeeUsd: median(chainFees),
    chainFeeSampleCount: chainFees.length,
    medianSettlementMs: median(settlementTimes),
    settlementSampleCount: settlementTimes.length,
    ledgerHeight: ledgerResult.count ?? 0,
    latestInstrumentedCycleAt: runs.at(-1)?.finished_at ?? null,
  };
}
