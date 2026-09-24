import { supabase, unwrap } from "./supabase";

const num = (value: unknown): number => Number(value ?? 0);

export interface TransferTelemetry {
  id: string;
  targetType: "invoice" | "milestone";
  targetId: string;
  txRef: string;
  feeUsd: number;
  feeSource: "chain_reported" | "provider_estimate" | "simulated_profile";
  settledInMs: number | null;
  chain: string;
  providerMode: "live" | "simulate";
  executedAt: string;
  status: string;
}

export interface CycleRunTelemetry {
  id: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  decisionCount: number;
  paidCount: number;
  heldCount: number;
  flaggedCount: number;
  awaitingInfoCount: number;
  releasedCount: number;
  modelDecisionCount: number;
  heuristicDecisionCount: number;
  guardrailOverrideCount: number;
  chainMode: "live" | "simulate";
  screeningMode: "live" | "simulate";
}

export interface CycleSnapshotTelemetry {
  id: string;
  cycleRunId: string;
  capturedAt: string;
  totalLiquid: number;
  openPayables: number;
  openReceivables: number;
  obligationsDue7d: number;
  obligationsDue14d: number;
  reservePosition: number;
  chainMode: "live" | "simulate";
}

export interface TreasuryMoveTelemetry {
  id: string;
  action: "sweep_to_usyc" | "redeem_from_usyc" | "rebalance";
  amount: number;
  createdAt: string;
}

export interface ScreeningTelemetry {
  id: string;
  counterpartyId: string;
  counterpartyName: string;
  riskLevel: string;
  previousRiskLevel: string | null;
  tierChanged: boolean;
  mode: "live" | "simulate";
  source: string;
  status: "complete" | "failed";
  createdAt: string;
}

interface ScreeningRow {
  id: string;
  counterparty_id: string;
  risk_level: string;
  screening_mode: "live" | "simulate";
  source: string;
  status: "complete" | "failed";
  created_at: string;
  counterparties: { name: string } | null;
}

export function annotateScreeningChanges(rows: ScreeningRow[]): ScreeningTelemetry[] {
  const previousByCounterparty = new Map<string, string>();
  return rows.map((row) => {
    const previousRiskLevel = previousByCounterparty.get(row.counterparty_id) ?? null;
    const tierChanged = row.status === "complete" && previousRiskLevel != null && previousRiskLevel !== row.risk_level;
    if (row.status === "complete") previousByCounterparty.set(row.counterparty_id, row.risk_level);
    return {
      id: row.id,
      counterpartyId: row.counterparty_id,
      counterpartyName: row.counterparties?.name ?? "Unknown counterparty",
      riskLevel: row.risk_level,
      previousRiskLevel,
      tierChanged,
      mode: row.screening_mode,
      source: row.source,
      status: row.status,
      createdAt: row.created_at,
    };
  });
}

async function listTransferTelemetry(): Promise<TransferTelemetry[]> {
  const rows = unwrap(
    await supabase()
      .from("payment_intents")
      .select("id, source_type, source_id, provider_tx_id, tx_hash, fee_usd, fee_source, settled_in_ms, chain, provider_mode, executed_at, status")
      .not("executed_at", "is", null)
      .not("fee_usd", "is", null)
      .order("executed_at", { ascending: false })
      .limit(120)
  ) as Array<Record<string, unknown>>;
  return rows.reverse().flatMap((row) => {
    if (!row.executed_at || !row.chain || !row.provider_mode || !row.fee_source) return [];
    const txRef = String(row.tx_hash ?? row.provider_tx_id ?? "");
    if (!txRef) return [];
    return [{
      id: String(row.id),
      targetType: row.source_type as TransferTelemetry["targetType"],
      targetId: String(row.source_id),
      txRef,
      feeUsd: num(row.fee_usd),
      feeSource: row.fee_source as TransferTelemetry["feeSource"],
      settledInMs: row.settled_in_ms == null ? null : num(row.settled_in_ms),
      chain: String(row.chain),
      providerMode: row.provider_mode as TransferTelemetry["providerMode"],
      executedAt: String(row.executed_at),
      status: String(row.status),
    }];
  });
}

async function listCycleRuns(): Promise<CycleRunTelemetry[]> {
  const rows = unwrap(
    await supabase().from("cycle_runs").select("*").order("finished_at", { ascending: false }).limit(120)
  ) as Array<Record<string, unknown>>;
  return rows.reverse().map((row) => ({
    id: String(row.id),
    startedAt: String(row.started_at),
    finishedAt: String(row.finished_at),
    durationMs: num(row.duration_ms),
    decisionCount: num(row.decision_count),
    paidCount: num(row.paid_count),
    heldCount: num(row.held_count),
    flaggedCount: num(row.flagged_count),
    awaitingInfoCount: num(row.awaiting_info_count),
    releasedCount: num(row.released_count),
    modelDecisionCount: num(row.model_decision_count),
    heuristicDecisionCount: num(row.heuristic_decision_count),
    guardrailOverrideCount: num(row.guardrail_override_count),
    chainMode: row.chain_mode as CycleRunTelemetry["chainMode"],
    screeningMode: row.screening_mode as CycleRunTelemetry["screeningMode"],
  }));
}

async function listCycleSnapshots(): Promise<CycleSnapshotTelemetry[]> {
  const rows = unwrap(
    await supabase().from("cycle_snapshots").select("*").order("captured_at", { ascending: false }).limit(120)
  ) as Array<Record<string, unknown>>;
  return rows.reverse().map((row) => ({
    id: String(row.id),
    cycleRunId: String(row.cycle_run_id),
    capturedAt: String(row.captured_at),
    totalLiquid: num(row.total_liquid),
    openPayables: num(row.open_payables),
    openReceivables: num(row.open_receivables),
    obligationsDue7d: num(row.obligations_due_7d),
    obligationsDue14d: num(row.obligations_due_14d),
    reservePosition: num(row.reserve_position),
    chainMode: row.chain_mode as CycleSnapshotTelemetry["chainMode"],
  }));
}

async function listTreasuryMoves(): Promise<TreasuryMoveTelemetry[]> {
  const rows = unwrap(
    await supabase().from("treasury_actions").select("id, action, amount, created_at").order("created_at", { ascending: false }).limit(120)
  ) as Array<Record<string, unknown>>;
  return rows.reverse().map((row) => ({
    id: String(row.id),
    action: row.action as TreasuryMoveTelemetry["action"],
    amount: num(row.amount),
    createdAt: String(row.created_at),
  }));
}

async function listScreeningHistory(): Promise<ScreeningTelemetry[]> {
  const rows = unwrap(
    await supabase()
      .from("compliance_checks")
      .select("id, counterparty_id, risk_level, screening_mode, source, status, created_at, counterparties(name)")
      .order("created_at", { ascending: false })
      .limit(500)
  ) as unknown as ScreeningRow[];
  return annotateScreeningChanges(rows.reverse());
}

export interface InsightsData {
  transfers: TransferTelemetry[];
  runs: CycleRunTelemetry[];
  snapshots: CycleSnapshotTelemetry[];
  treasuryMoves: TreasuryMoveTelemetry[];
  screenings: ScreeningTelemetry[];
}

/** One server-side query boundary for every chart on the Insights route. */
export async function getInsightsData(): Promise<InsightsData> {
  const [transfers, runs, snapshots, treasuryMoves, screenings] = await Promise.all([
    listTransferTelemetry(),
    listCycleRuns(),
    listCycleSnapshots(),
    listTreasuryMoves(),
    listScreeningHistory(),
  ]);
  return { transfers, runs, snapshots, treasuryMoves, screenings };
}
