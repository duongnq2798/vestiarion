import { connectionFor, NotSetUpError } from "../connectors/connections";
import { db } from "../dal";
import type { AcceptanceEvent } from "./acceptance";
import { AsanaNotSetUpError, asanaReady, liveLinks } from "./links";
import { asanaSettingsFromEnv } from "./settings";
import { asanaPanelView, type AsanaPanelView } from "./views";

/** The entries the card's figures are read from (A14): acceptances, those taken back, and the agent's decisions after. */
const KPI_ACTIONS = ["milestone_accepted", "milestone_acceptance_withdrawn", "milestone_release", "milestone_hold"] as const;

/** The Asana card of Settings, in the workspace's scope; null where Asana is not configured, so the card is not there. */
export async function asanaPanelFor(nowMs: number = Date.now()): Promise<AsanaPanelView | null> {
  if (!asanaSettingsFromEnv()) return null;
  try {
    const connection = await connectionFor("asana");
    await asanaReady();
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
    return asanaPanelView({ connection, links, events, nowMs });
  } catch (error) {
    if (error instanceof NotSetUpError || error instanceof AsanaNotSetUpError) return { state: "not_set_up" };
    throw error;
  }
}
