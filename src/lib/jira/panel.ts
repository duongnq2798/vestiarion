import { connectionFor, NotSetUpError } from "../connectors/connections";
import { currentOrgId } from "../context";
import { db } from "../dal";
import { ACCEPTED_ACTION, WITHDRAWN_ACTION, type AcceptanceEvent } from "./acceptance";
import { JiraNotSetUpError, jiraReady, linksOfMilestones, liveLinks } from "./links";
import { jiraSettingsFromEnv } from "./settings";
import { siteFor } from "./sites";
import { jiraPanelView, type JiraPanelView } from "./views";
import { OPEN_STATUSES } from "./webhooks";

/**
 * The entries the card's figures are read from (JR21): Jira's acceptances, those taken back, and the agent's decisions
 * after them. Asana's and Linear's acceptances are their own entries, and never counted here.
 */
const KPI_ACTIONS = [ACCEPTED_ACTION, WITHDRAWN_ACTION, "milestone_release", "milestone_hold"] as const;

/** Enough open links to know whether the site has any: the card says whether Jira's notices arrive only then. */
const OPEN_LOOK = 100;

/**
 * The Jira card of Settings (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR1, JR21, JR22), in the
 * workspace's scope; null where Jira is not configured, so the card is not there, as Linear's. Before migration 0149 it
 * says Jira is not set up yet.
 */
export async function jiraPanelFor(nowMs: number = Date.now()): Promise<JiraPanelView | null> {
  if (!jiraSettingsFromEnv()) return null;
  try {
    const connection = await connectionFor("jira");
    await jiraReady();
    if (!connection) return { state: "not_connected" };
    const revoked = connection.status === "revoked";
    const links = revoked ? [] : await liveLinks({ connectionId: connection.id, limit: 500 });
    const site = revoked ? null : await siteFor(currentOrgId(), connection.id);
    // The open milestones linked to an issue on the connected site: what the webhook is kept for (JR14).
    const open = revoked ? [] : (await linksOfMilestones({ statuses: OPEN_STATUSES, limit: OPEN_LOOK })).filter((link) => link.cloudId === connection.externalOrgId);
    const since = new Date(nowMs - 31 * 86_400_000).toISOString();
    const entries = await db().from("ledger_entries").select("action, ts, detail").eq("domain", "contractor").in("action", [...KPI_ACTIONS]).gte("ts", since).order("seq", { ascending: false }).limit(1000);
    if (entries.error) throw new Error(entries.error.message);
    const events: AcceptanceEvent[] = ((entries.data ?? []) as Array<{ action: string; ts: string; detail: Record<string, unknown> | null }>).map((row) => ({
      action: row.action,
      ts: row.ts,
      milestoneId: typeof row.detail?.milestoneId === "string" ? row.detail.milestoneId : null,
    }));
    return jiraPanelView({ connection, site, links, openLinks: open.length, events, nowMs });
  } catch (error) {
    if (error instanceof NotSetUpError || error instanceof JiraNotSetUpError) return { state: "not_set_up" };
    throw error;
  }
}
