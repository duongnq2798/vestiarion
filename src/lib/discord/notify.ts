import type { ActivityItem } from "../agent-activity";
import { readAgentActivity } from "../agent-activity-read";
import { siteOrigin } from "../auth/env";
import { currentOrgId } from "../context";
import { platformDb, unwrap } from "../dal";
import { noticePolicy, waitingBills, withUsdcValues } from "../notifications/waiting-bills";
import { buildWaitingNotice } from "../notifications/waiting-notice";
import type { NoticeLine } from "../payment-notices";
import { masterKeysFromEnv, type MasterKey } from "../secrets";
import { postToDiscord, webhookGone, type DiscordResult } from "./api";
import { clearFailure, moveCursor, readConnection, recordFailure, removeConnection, webhookUrlOf, type DiscordConnection } from "./connections";
import { waitingMessage } from "./messages";

/**
 * The cycle's `discord` stage (docs/superpowers/specs/2026-10-22-discord-design.md DC3, DC5): the workspace's Discord
 * channel is told which payables the agent stopped for a person since its cursor, read the way the Slack and Telegram
 * stages read the agent's decisions, page after page up to the ledger's head, and kept only while each is still held or
 * flagged, re-read in one query. One message a cycle; the cursor then moves past everything read, but only once Discord
 * took it, or refused it outright so that one bad message cannot jam the channel. A webhook Discord says is gone is
 * disconnected. Runs inside the workspace's scope; quietly does nothing before migration 0140 or without a connection.
 */

/** No wait starts that would end after this long: the cycle has a row to close. */
export const STAGE_BUDGET_MS = 20_000;
/** The longest a 429 is waited out, once, in the stage; anything longer is left to the next cycle. */
export const WAIT_AT_MOST_MS = 2_000;
/**
 * Another page of activity is read only while less than this much of the stage has gone, so the post's own 10-second
 * deadline (DC5) and its one short wait still fit in the budget.
 */
export const READ_BUDGET_MS = STAGE_BUDGET_MS - 12_000;

export interface DiscordNotifyDeps {
  fetchImpl?: typeof fetch;
  origin?: string;
  keys?: MasterKey[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** What Settings shows of a post Discord did not take: its status and code, never the URL. */
function failureText(posted: DiscordResult): string {
  if (posted.status === 0) return "Discord could not be reached. The bills are posted again with the next cycle.";
  if (posted.status >= 500) return `Discord answered ${posted.status}. The bills are posted again with the next cycle.`;
  return `Discord refused the message (${posted.status}${posted.code !== null ? `, code ${posted.code}` : ""}). Those bills wait in Approvals.`;
}

async function settle(connection: DiscordConnection, through: number, posted: DiscordResult, total: number): Promise<NoticeLine[]> {
  if (posted.ok) {
    await moveCursor(connection.id, through);
    if (connection.failures > 0 || connection.lastError !== null) await clearFailure(connection.id);
    return [{ domain: "system", message: `Told the workspace's Discord channel that ${total === 1 ? "1 bill waits" : `${total} bills wait`} for approval` }];
  }
  // The status and Discord's code, never the webhook's URL: it is a credential.
  if (webhookGone(posted)) {
    console.error("discord: the webhook is gone, disconnected", connection.orgId, posted.status, posted.code);
    await removeConnection(connection, "discord", null);
    return [{ domain: "system", message: "Discord said the workspace's channel webhook is gone, so Discord was disconnected" }];
  }
  if (posted.status === 429) {
    console.error("discord: rate limited, kept for the next cycle", connection.orgId, posted.retryAfterMs);
    return [];
  }
  await recordFailure(connection, failureText(posted));
  if (posted.status === 0 || posted.status >= 500) {
    console.error("discord: waiting bills not posted, kept for the next cycle", connection.orgId, posted.status);
    return [];
  }
  // Refused outright (400, or another refusal of the message itself): passed over, so it cannot hold the cursor for ever.
  console.error("discord: waiting bills refused, passed over", connection.orgId, posted.status, posted.code);
  await moveCursor(connection.id, through);
  return [];
}

/**
 * The agent's activity after the cursor, page after page, up to the ledger's head: one read returns a page at most, and a
 * cycle that wrote more would otherwise leave the rest of its held bills to the next cycle, which may be hours away. Stops
 * early, at the last entry read, once the stage has spent its time for reading, so the post still fits in the budget.
 */
async function readSinceCursor(since: number, started: number, now: () => number): Promise<{ items: ActivityItem[]; through: number }> {
  const items: ActivityItem[] = [];
  let through = since;
  for (;;) {
    const page = await readAgentActivity(through);
    items.push(...page.items);
    // No progress, or every entry up to the head is read.
    if (page.through <= through || page.through >= page.head) return { items, through: Math.max(through, page.through) };
    through = page.through;
    if (now() - started >= READ_BUDGET_MS) return { items, through };
  }
}

export async function sendDiscordWaiting(deps: DiscordNotifyDeps = {}): Promise<NoticeLine[]> {
  const orgId = currentOrgId();
  const found = await readConnection(orgId);
  if (!found.ready || !found.connection) return [];
  const connection = found.connection;

  const now = deps.now ?? Date.now;
  const started = now();
  const read = await readSinceCursor(connection.notifiedSeq, started, now);
  const bills = await waitingBills(read.items);
  if (bills.length === 0) {
    if (read.through > connection.notifiedSeq) await moveCursor(connection.id, read.through);
    return [];
  }

  const workspace = unwrap(await platformDb().from("orgs").select("slug, name").eq("id", orgId).single<{ slug: string; name: string }>());
  const policy = await noticePolicy("discord");
  const notice = buildWaitingNotice(await withUsdcValues(bills, policy), policy);
  const content = waitingMessage(workspace, notice, deps.origin ?? siteOrigin());
  const url = webhookUrlOf(connection, deps.keys ?? masterKeysFromEnv());

  let posted = await postToDiscord(url, { content }, deps.fetchImpl);
  // Waited out once, when Discord asks for little enough and the stage has the time (DC5).
  if (posted.status === 429 && posted.retryAfterMs !== null && posted.retryAfterMs <= WAIT_AT_MOST_MS && now() - started + posted.retryAfterMs <= STAGE_BUDGET_MS) {
    await (deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(posted.retryAfterMs);
    posted = await postToDiscord(url, { content }, deps.fetchImpl);
  }
  return settle(connection, read.through, posted, notice.total);
}
