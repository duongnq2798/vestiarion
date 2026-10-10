import { CYCLE_IN_PROGRESS_MS } from "./agent/balances";
import { currentOrgId } from "./context";
import { db, unwrap, type OrgDb } from "./dal";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";
import { SHADOW_CURRENCIES, shadowCurrency, shadowModeCurrency, type ShadowMode } from "./shadow-currency";
import { workspaceNetwork } from "./workspace-network";

/**
 * Shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S1): a business keeps paying its bills as it
 * does today, in its own currency, while the agent decides on the same bills and pays nothing until a person agrees.
 * One row per workspace in `shadow_modes`, read by the agent once per stage. Arc testnet only: on Arc mainnet the agent
 * pays the real bills. Every export runs inside an organization scope; who may turn it on and off (`approval.policy`,
 * owners) is the caller's check. A change is refused while a cycle runs, as two approvals are: the cycle read it when
 * it began.
 */

export { SHADOW_CURRENCIES, shadowCurrency, type ShadowMode };

/** The console's `?shadow=` when shadow mode was asked for as the workspace was created, and did not turn on. */
export const SHADOW_NOT_STARTED = "not-started";

export type ShadowModeErrorCode = "invalid_currency" | "mainnet" | "already_on" | "already_off" | "cycle_running";

const MESSAGES: Record<ShadowModeErrorCode, string> = {
  invalid_currency: "Choose USDC, or the currency your bills are written in as a three-letter code, such as EUR.",
  mainnet: "Shadow mode runs on Arc testnet. On Arc mainnet the agent pays your real bills.",
  already_on: "Shadow mode is already on.",
  already_off: "Shadow mode is already off.",
  cycle_running: "A cycle is running. Try again in a minute, once it has finished.",
};

export class ShadowModeError extends Error {
  constructor(readonly code: ShadowModeErrorCode) {
    super(MESSAGES[code]);
    this.name = "ShadowModeError";
  }
}

/** The workspace's shadow mode, or null when it is off. A row that cannot be read throws: nothing is paid on a guess. */
export async function readShadowMode(orgDb: OrgDb): Promise<ShadowMode | null> {
  const result = await orgDb.from("shadow_modes").select("currency, started_at, started_by").limit(1);
  if (result.error) throw new Error(`shadow_modes not read: ${result.error.message}`);
  const row = ((result.data ?? []) as Array<{ currency: string; started_at: string; started_by: string | null }>)[0];
  return row ? { currency: row.currency, startedAt: row.started_at, startedBy: row.started_by } : null;
}

async function refuseWhileCycleRuns(): Promise<void> {
  const running = unwrap(
    await db()
      .from("cycle_runs")
      .select("id")
      .eq("status", "running")
      .gt("started_at", new Date(Date.now() - CYCLE_IN_PROGRESS_MS).toISOString())
      .limit(1)
  ) as Array<{ id: string }>;
  if (running.length > 0) throw new ShadowModeError("cycle_running");
}

export async function startShadowMode(input: { actorId: string; currency: string }): Promise<ShadowMode> {
  const currency = shadowModeCurrency(input.currency);
  if (!currency) throw new ShadowModeError("invalid_currency");
  if (workspaceNetwork().id === "arc-mainnet") throw new ShadowModeError("mainnet");
  if (await readShadowMode(db())) throw new ShadowModeError("already_on");
  await refuseWhileCycleRuns();

  const startedAt = new Date().toISOString();
  // A write that asks for nothing back: only its error says whether it happened. A row written a moment before, from
  // another tab, is the workspace's one row already.
  const write = await db().from("shadow_modes").insert({ currency, started_by: input.actorId, started_at: startedAt });
  if (write.error) {
    if (write.error.code === "23505") throw new ShadowModeError("already_on");
    throw new Error(write.error.message);
  }

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "system",
    action: "shadow_mode_started",
    summary: `Shadow mode started, for bills in ${currency}: the agent pays nothing until a person agrees`,
    detail: { by: input.actorId, currency },
  });
  return { currency, startedAt, startedBy: input.actorId };
}

export async function endShadowMode(input: { actorId: string }): Promise<void> {
  const current = await readShadowMode(db());
  if (!current) throw new ShadowModeError("already_off");
  await refuseWhileCycleRuns();

  // Turned off a moment before, from another tab: that was this change, and it is recorded once (review M5).
  const removed = await db().from("shadow_modes").delete().eq("org_id", currentOrgId()).select("org_id");
  if (removed.error) throw new Error(removed.error.message);
  if ((removed.data ?? []).length === 0) throw new ShadowModeError("already_off");

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "system",
    action: "shadow_mode_ended",
    summary: `Shadow mode ended: the agent pays within its limits again`,
    detail: { by: input.actorId, currency: current.currency },
  });
}
