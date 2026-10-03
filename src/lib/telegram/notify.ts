import { readAgentActivity, type AgentActivity } from "../agent-activity-read";
import { siteOrigin } from "../auth/env";
import { currentOrgId } from "../context";
import type { NoticeLine } from "../payment-notices";
import { telegramClient, type TelegramClient } from "./client";
import { disconnect, linksForOrg, moveCursor, workspaceOf, type TelegramLink, type Workspace } from "./links";
import { decisionsMessage, plainText } from "./messages";
import { telegramSettingsFromEnv, type TelegramSettings } from "./settings";

/**
 * The cycle's `telegram` stage (Telegram bot design R8): every chat connected to the workspace is told the agent's
 * decisions after its cursor, read the way the console's activity toasts read them, and its cursor then moves past
 * everything read. A send that failed keeps the cursor, so the next cycle sends again; a chat that blocked the bot is
 * disconnected; a message Telegram refused to parse is sent once more as plain text and then passed, so no message can
 * hold a cursor for ever. Runs inside the workspace's scope; quietly does nothing when the bot is not configured.
 */

/** No send starts after this long: the cycle has a row to close. */
export const STAGE_BUDGET_MS = 20_000;

export interface NotifyDeps {
  settings?: TelegramSettings | null;
  client?: TelegramClient;
  origin?: string;
  now?: () => number;
}

type Told = "told" | "nothing" | "kept";

async function tell(link: TelegramLink, read: AgentActivity, workspace: Workspace, client: TelegramClient, origin: string): Promise<Told> {
  if (read.items.length === 0) {
    if (read.through > link.notifiedSeq) await moveCursor(link.id, read.through);
    return "nothing";
  }
  const text = decisionsMessage(workspace, read.items, origin);
  let sent = await client.sendMessage(link.chatId, text);
  if (!sent.ok && sent.status === 400) sent = await client.sendMessage(link.chatId, plainText(text), { plain: true });
  if (sent.ok) {
    await moveCursor(link.id, read.through);
    return "told";
  }
  if (sent.status === 403) {
    await disconnect(link, "blocked", null);
    return "kept";
  }
  if (sent.status === 400) {
    console.error("telegram: decisions refused twice, passed over", link.orgId, link.id, sent.description);
    await moveCursor(link.id, read.through);
    return "kept";
  }
  console.error("telegram: decisions not sent, kept for the next cycle", link.orgId, link.id, sent.status);
  return "kept";
}

export async function sendAgentDecisions(deps: NotifyDeps = {}): Promise<NoticeLine[]> {
  const settings = deps.settings === undefined ? telegramSettingsFromEnv() : deps.settings;
  if (!settings) return [];
  const orgId = currentOrgId();
  const links = await linksForOrg(orgId);
  if (links.length === 0) return [];

  const client = deps.client ?? telegramClient(settings);
  const origin = deps.origin ?? siteOrigin();
  const now = deps.now ?? Date.now;
  const workspace = await workspaceOf(orgId);
  const started = now();
  // Chats connected at the same moment share a cursor: their decisions are read once.
  const reads = new Map<number, Promise<AgentActivity>>();
  let told = 0;

  for (const link of links) {
    if (now() - started > STAGE_BUDGET_MS) break;
    try {
      let read = reads.get(link.notifiedSeq);
      if (!read) {
        read = readAgentActivity(link.notifiedSeq);
        reads.set(link.notifiedSeq, read);
      }
      if ((await tell(link, await read, workspace, client, origin)) === "told") told += 1;
    } catch (error) {
      console.error("telegram: decisions not told", orgId, link.id, error instanceof Error ? error.message : "unknown error");
    }
  }
  return told > 0 ? [{ domain: "system", message: `Told ${told} Telegram chat${told === 1 ? "" : "s"} what the agent decided` }] : [];
}
