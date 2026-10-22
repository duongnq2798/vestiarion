import type { ActivityItem } from "../agent-activity";
import { readAgentActivity, type AgentActivity } from "../agent-activity-read";
import { usdcValueOfLatestDecision } from "../agent/second-approval";
import { readAccountantCosign, readTwoApprovalsAbove } from "../approval-policy";
import { siteOrigin } from "../auth/env";
import { currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { buildWaitingNotice, NOTICE_MAX_BILLS, type NoticePolicy, type WaitingBill } from "../notifications/waiting-notice";
import type { NoticeLine } from "../payment-notices";
import { masterKeysFromEnv, type MasterKey } from "../secrets";
import { postToDiscord, webhookGone, type DiscordResult } from "./api";
import { clearFailure, moveCursor, readConnection, recordFailure, removeConnection, webhookUrlOf, type DiscordConnection } from "./connections";
import { waitingMessage } from "./messages";

/**
 * The cycle's `discord` stage (docs/superpowers/specs/2026-10-22-discord-design.md DC3, DC5): the workspace's Discord
 * channel is told which payables the agent stopped for a person since its cursor, read the way the Slack and Telegram
 * stages read the agent's decisions, and kept only while each is still held or flagged, re-read in one query. One
 * message a cycle; the cursor then moves past everything read, but only once Discord took it, or refused it outright so
 * that one bad message cannot jam the channel. A webhook Discord says is gone is disconnected. Runs inside the
 * workspace's scope; quietly does nothing before migration 0139 or without a connection.
 */

/** No wait starts that would end after this long: the cycle has a row to close. */
export const STAGE_BUDGET_MS = 20_000;
/** The longest a 429 is waited out, once, in the stage; anything longer is left to the next cycle. */
export const WAIT_AT_MOST_MS = 2_000;

export interface DiscordNotifyDeps {
  fetchImpl?: typeof fetch;
  origin?: string;
  keys?: MasterKey[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const WAITING = ["held", "flagged"];

interface BillRow {
  id: string;
  amount: string | number;
  currency: string | null;
  status: string;
  direction: string;
  agent_reasoning: string | null;
  counterparties: { name: string } | null;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "unknown error");

/**
 * The payables the agent stopped for a person among what was read, still held or flagged now, in the order it stopped
 * them: a bill a person decided since, or one waiting for details rather than approval, is left out.
 */
async function waitingBills(items: readonly ActivityItem[]): Promise<WaitingBill[]> {
  const ids = [
    ...new Set(items.filter((item) => item.tone === "stopped" && item.invoiceId && item.path.startsWith("/approvals")).map((item) => item.invoiceId as string)),
  ];
  if (ids.length === 0) return [];
  const rows = unwrap(
    await db().from("invoices").select("id, amount, currency, status, direction, agent_reasoning, counterparties(name)").in("id", ids)
  ) as unknown as BillRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id): WaitingBill[] => {
    const row = byId.get(id);
    if (!row || row.direction !== "payable" || !WAITING.includes(row.status)) return [];
    return [
      {
        id,
        payee: row.counterparties?.name ?? "a payee",
        amount: Number(row.amount),
        currency: row.currency === "EURC" ? "EURC" : "USDC",
        status: row.status as WaitingBill["status"],
        reasoning: row.agent_reasoning,
      },
    ];
  });
}

/**
 * The figure for two approvals and whether accountants co-sign, for what the notice says each bill needs. A rule that
 * cannot be read leaves that out of the notice rather than stop it: the bills still wait, and Approvals says the rest.
 */
async function noticePolicy(): Promise<NoticePolicy> {
  let twoApprovalsAbove: number | null = null;
  try {
    twoApprovalsAbove = await readTwoApprovalsAbove(db());
  } catch (error) {
    console.error("discord: the figure for two approvals was not read", currentOrgId(), messageOf(error));
  }
  let accountantCosigns = false;
  if (twoApprovalsAbove !== null) {
    try {
      accountantCosigns = (await readAccountantCosign(db())).on;
    } catch (error) {
      console.error("discord: accountant co-sign was not read", currentOrgId(), messageOf(error));
    }
  }
  return { twoApprovalsAbove, accountantCosigns };
}

/** Each listed EURC bill's USDC value as the agent last weighed it, where a figure makes it matter (two approvals T2). */
async function withUsdcValues(bills: WaitingBill[], policy: NoticePolicy): Promise<WaitingBill[]> {
  if (policy.twoApprovalsAbove === null) return bills;
  return Promise.all(
    bills.map(async (bill, index) => {
      if (bill.currency !== "EURC" || index >= NOTICE_MAX_BILLS) return bill;
      try {
        return { ...bill, usdcValue: await usdcValueOfLatestDecision(bill.id) };
      } catch {
        return bill;
      }
    })
  );
}

/** What Settings shows of a post Discord did not take: its status and code, never the URL. */
function failureText(posted: DiscordResult): string {
  if (posted.status === 0) return "Discord could not be reached. The bills are posted again with the next cycle.";
  if (posted.status >= 500) return `Discord answered ${posted.status}. The bills are posted again with the next cycle.`;
  return `Discord refused the message (${posted.status}${posted.code !== null ? `, code ${posted.code}` : ""}). Those bills wait in Approvals.`;
}

async function settle(connection: DiscordConnection, read: AgentActivity, posted: DiscordResult, total: number): Promise<NoticeLine[]> {
  if (posted.ok) {
    await moveCursor(connection.id, read.through);
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
  await moveCursor(connection.id, read.through);
  return [];
}

export async function sendDiscordWaiting(deps: DiscordNotifyDeps = {}): Promise<NoticeLine[]> {
  const orgId = currentOrgId();
  const found = await readConnection(orgId);
  if (!found.ready || !found.connection) return [];
  const connection = found.connection;

  const now = deps.now ?? Date.now;
  const started = now();
  const read = await readAgentActivity(connection.notifiedSeq);
  const bills = await waitingBills(read.items);
  if (bills.length === 0) {
    if (read.through > connection.notifiedSeq) await moveCursor(connection.id, read.through);
    return [];
  }

  const workspace = unwrap(await platformDb().from("orgs").select("slug, name").eq("id", orgId).single<{ slug: string; name: string }>());
  const policy = await noticePolicy();
  const notice = buildWaitingNotice(await withUsdcValues(bills, policy), policy);
  const content = waitingMessage(workspace, notice, deps.origin ?? siteOrigin());
  const url = webhookUrlOf(connection, deps.keys ?? masterKeysFromEnv());

  let posted = await postToDiscord(url, { content }, deps.fetchImpl);
  // Waited out once, when Discord asks for little enough and the stage has the time (DC5).
  if (posted.status === 429 && posted.retryAfterMs !== null && posted.retryAfterMs <= WAIT_AT_MOST_MS && now() - started + posted.retryAfterMs <= STAGE_BUDGET_MS) {
    await (deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(posted.retryAfterMs);
    posted = await postToDiscord(url, { content }, deps.fetchImpl);
  }
  return settle(connection, read, posted, notice.total);
}
