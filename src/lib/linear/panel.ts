import { connectionFor, NotSetUpError } from "../connectors/connections";
import { db } from "../dal";
import { ACCEPTED_ACTION, WITHDRAWN_ACTION, type AcceptanceEvent } from "./acceptance";
import { LinearNotSetUpError, linearReady, liveLinks } from "./links";
import { linearSettingsFromEnv } from "./settings";
import { linearPanelView, type LinearPanelView } from "./views";

/**
 * The entries the card's figures are read from (LN15): Linear's acceptances, those taken back, and the agent's decisions
 * after them. Asana's acceptances are its own entries, and never counted here.
 */
const KPI_ACTIONS = [ACCEPTED_ACTION, WITHDRAWN_ACTION, "milestone_release", "milestone_hold"] as const;

/** The Linear card of Settings, in the workspace's scope; null where Linear is not configured, so the card is not there. */
export async function linearPanelFor(nowMs: number = Date.now()): Promise<LinearPanelView | null> {
  if (!linearSettingsFromEnv()) return null;
  try {
    const connection = await connectionFor("linear");
    await linearReady();
    if (!connection) return { state: "not_connected" };
    const links = connection.status === "revoked" ? [] : await liveLinks({ connectionId: connection.id, limit: 500 });
    const since = new Date(nowMs - 31 * 86_400_000).toISOString();
    const entries = await db().from("ledger_entries").select("action, ts, detail").eq("domain", "contractor").in("action", [...KPI_ACTIONS]).gte("ts", since).order("seq", { ascending: false }).limit(1000);
    if (entries.error) throw new Error(entries.error.message);
    const events: AcceptanceEvent[] = ((entries.data ?? []) as Array<{ action: string; ts: string; detail: Record<string, unknown> | null }>).map((row) => ({
      action: row.action,
      ts: row.ts,
      milestoneId: typeof row.detail?.milestoneId === "string" ? row.detail.milestoneId : null,
    }));
    return linearPanelView({ connection, links, events, nowMs });
  } catch (error) {
    if (error instanceof NotSetUpError || error instanceof LinearNotSetUpError) return { state: "not_set_up" };
    throw error;
  }
}
