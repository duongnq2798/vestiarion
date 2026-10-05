import { getChainProvider } from "../circle";
import { currentOrgConfig } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { onceQuotes, probeFx } from "../fx/probe";
import { fxChange, fxRecheckCandidates, type RecheckEntry } from "../fx/recheck";
import { CycleRunningError } from "./cycle-running";
import type { CycleEventKind } from "./cycle-soon";
import { runAgentCycle } from "./orchestrator";
import { AgentPausedError } from "./pause";
import { paymentsDisabled, PaymentsDisabledError } from "../payments-switch";

/**
 * The watcher that decides a EURC payable again when the rate changes what held it, with no one pressing anything
 * (docs/superpowers/specs/2026-10-05-fx-reevaluation-design.md F4).
 *
 * Every few minutes (`POST /api/agent/fx-watch`, from GitHub Actions), in each live workspace whose agent is not paused,
 * it finds the payables a decision held for FX that are due a re-check (F1, F5) and asks one fresh quote for each, at
 * most three (F9). Only when a quote clears what held one does it run a cycle, with the event `fx_changed`. That
 * cycle's follow-up stage asks again, reopens the payable, and records the quote before and after (F3, F6).
 *
 * With nothing held, nothing due or nothing cleared, it runs no cycle, writes nothing and calls no model. It never
 * writes itself (F7). Sandbox workspaces are left to the cycles a member runs, as the schedule leaves them (F8).
 */

/** At most this many payables get a fresh quote in one workspace per run (F9). */
export const FX_RECHECKS_PER_WATCH = 3;

export interface FxWatchResult {
  slug: string;
  /** EURC payables held in the workspace. */
  held: number;
  /** How many were asked a fresh quote. */
  probed: number;
  /** How many a quote cleared. */
  cleared: number;
  /** `payments_off`: the platform has payments switched off, so nothing is asked or run (payment safety S3). */
  cycle: "none" | "ran" | "running" | "paused" | "failed" | "payments_off";
  error?: string;
}

type Quotes = ReturnType<typeof onceQuotes>;

interface WatchDeps {
  /** The quotes a re-check asks with; the workspace's operating wallet and Circle key unless a test passes its own. */
  quotes?: () => Promise<Quotes>;
  now?: () => number;
}

export async function watchFxHolds(deps: WatchDeps = {}): Promise<FxWatchResult[]> {
  const orgs = unwrap(
    await platformDb().from("orgs").select("id, slug, agent_paused_at").eq("mode", "live").order("slug")
  ) as unknown as Array<{ id: string; slug: string; agent_paused_at: string | null }>;

  const results: FxWatchResult[] = [];
  const off = await paymentsDisabled();
  for (const org of orgs) {
    if (off) {
      results.push({ slug: org.slug, held: 0, probed: 0, cleared: 0, cycle: "payments_off" });
      continue;
    }
    if (org.agent_paused_at) {
      results.push({ slug: org.slug, held: 0, probed: 0, cleared: 0, cycle: "paused" });
      continue;
    }
    try {
      results.push(await withOrg(org.id, () => watchWorkspace(org.slug, deps)));
    } catch (error) {
      // One workspace's failure is its own, as in the schedule.
      const message = error instanceof Error ? error.message : String(error);
      console.error("fx watch failed for", org.slug, message);
      results.push({ slug: org.slug, held: 0, probed: 0, cleared: 0, cycle: "failed", error: message });
    }
  }
  return results;
}

async function watchWorkspace(slug: string, deps: WatchDeps): Promise<FxWatchResult> {
  const orgDb = db();
  const held = unwrap(
    await orgDb
      .from("invoices")
      .select("id, status, decided_at, counterparties(payment_limit)")
      .eq("direction", "payable")
      .eq("status", "held")
      .eq("currency", "EURC")
    // PostgREST types an embedded row as an array; it is one-to-one here.
  ) as unknown as Array<{ id: string; status: string; decided_at: string | null; counterparties: { payment_limit: string | number | null } | null }>;
  const result = (probed: number, cleared: number, cycle: FxWatchResult["cycle"]): FxWatchResult => ({ slug, held: held.length, probed, cleared, cycle });
  if (held.length === 0) return result(0, 0, "none");

  const entries = unwrap(
    await orgDb
      .from("ledger_entries")
      .select("seq, ts, action, detail")
      .eq("domain", "ap")
      .in("detail->>invoiceId", held.map((row) => row.id))
      .order("seq", { ascending: false })
  ) as RecheckEntry[];
  const byInvoice = new Map<string, RecheckEntry[]>();
  for (const entry of entries) {
    const invoiceId = entry.detail.invoiceId as string | undefined;
    if (!invoiceId) continue;
    const list = byInvoice.get(invoiceId);
    if (list) list.push(entry);
    else byInvoice.set(invoiceId, [entry]);
  }

  const due = fxRecheckCandidates(
    held.map((row) => ({ id: row.id, status: row.status, decidedAt: row.decided_at })),
    byInvoice,
    (deps.now ?? Date.now)(),
    FX_RECHECKS_PER_WATCH
  );
  if (due.length === 0) return result(0, 0, "none");

  const quotes = await (deps.quotes ?? (() => workspaceQuotes()))();
  let cleared = 0;
  for (const candidate of due) {
    const fresh = await probeFx(candidate.hold, quotes);
    const limit = held.find((row) => row.id === candidate.id)?.counterparties?.payment_limit;
    if (fxChange(candidate.hold, fresh, limit == null ? null : Number(limit))) cleared += 1;
  }
  if (cleared === 0) return result(due.length, 0, "none");

  try {
    const event: CycleEventKind = "fx_changed";
    await runAgentCycle({ trigger: { kind: "event", events: [event] } });
    return result(due.length, cleared, "ran");
  } catch (error) {
    // One cycle at a time (F7): the cycle already running re-checks the same payables in its follow-up stage.
    if (error instanceof CycleRunningError) return result(due.length, cleared, "running");
    if (error instanceof AgentPausedError) return result(due.length, cleared, "paused");
    if (error instanceof PaymentsDisabledError) return result(due.length, cleared, "payments_off");
    throw error;
  }
}

/** The quotes the workspace in scope asks with: from its operating wallet, with a swap only where it can make one. */
async function workspaceQuotes(): Promise<Quotes> {
  const provider = getChainProvider();
  const operatingAddress =
    (unwrap(await db().from("accounts").select("address").eq("kind", "operating").limit(1)) as Array<{ address: string | null }>)[0]?.address ?? null;
  return onceQuotes({
    network: provider.network,
    operatingAddress,
    canSwap: provider.mode === "live" && typeof provider.swapForEurc === "function",
    apiKey: currentOrgConfig().chain.circleApiKey ?? null,
  });
}
