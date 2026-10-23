import { orgHref } from "../auth/org-paths";
import type { WaitingNotice, WaitingNoticeEntry } from "../notifications/waiting-notice";
import { DISCORD_CONTENT_MAX } from "./api";
import { discordText } from "./escape";

/**
 * What Vestiarion posts to a Discord channel (docs/superpowers/specs/2026-10-22-discord-design.md DC3, DC4), as
 * Discord's markdown: every value through `discordText`, only Vestiarion's own links added as they are, inside `<…>`,
 * and no message longer than Discord's 2,000 characters. Pure: the stage reads the bills, and posts the text.
 */

/** Said once in every message: a link opens the bill in Vestiarion, signed in, and decides nothing. */
export const NEVER_APPROVES = "Opening a link never approves anything.";

const STATUS: Record<WaitingNoticeEntry["status"], string> = { held: "held", flagged: "flagged", awaiting_info: "waiting for details" };

/** A page of the workspace, as an absolute link Discord shows without a preview. */
const link = (origin: string, slug: string, path: string) => `<${origin}${orgHref(slug, path)}>`;

/** One bill, on one line: how much, to whom, why, what it needs, and where to review it. */
function billLine(entry: WaitingNoticeEntry, origin: string, slug: string): string {
  const parts = [`**${discordText(entry.amountText, 60)}**`, discordText(entry.payee, 100)];
  parts.push(entry.reason ? `${STATUS[entry.status]}: ${discordText(entry.reason)}` : STATUS[entry.status]);
  if (entry.twoApprovals) parts.push(entry.cosign ? "needs two approvals, an accountant can co-sign" : "needs two approvals");
  parts.push(`Review: ${link(origin, slug, entry.reviewPath)}`);
  return `• ${parts.join(" · ")}`;
}

/**
 * The bills waiting for approval, in one message (DC3): up to ten, one line each, then how many more wait in Approvals.
 * A bill that would pass the length limit is counted among the more, never cut.
 */
export function waitingMessage(workspace: { name: string; slug: string }, notice: WaitingNotice, origin: string): string {
  const header = `**${discordText(workspace.name, 100)}** · ${notice.total === 1 ? "1 bill waits" : `${notice.total} bills wait`} for approval`;
  const more = (n: number) => `…and ${n} more in Approvals: ${link(origin, workspace.slug, "/approvals")}`;
  // Room kept for the closing lines, whatever is left out.
  const closing = `\n${more(notice.total)}\n${NEVER_APPROVES}`.length;
  let message = `${header}\n`;
  let shown = 0;
  for (const entry of notice.entries) {
    const line = `\n${billLine(entry, origin, workspace.slug)}`;
    if (message.length + line.length + closing > DISCORD_CONTENT_MAX) break;
    message += line;
    shown += 1;
  }
  const left = notice.total - shown;
  return `${message}${left > 0 ? `\n${more(left)}` : ""}\n${NEVER_APPROVES}`;
}

/**
 * What connecting posts before the connection is saved (DC1), so it claims nothing the save could still undo: it checks
 * the webhook, and says the channel hears more once Settings says Discord is connected.
 */
export function connectedMessage(workspaceName: string): string {
  return `A test message from Vestiarion for **${discordText(workspaceName, 100)}**, checking this webhook. Once Settings says Discord is connected, bills the agent holds for approval are posted here, each with a link to review it in Vestiarion. ${NEVER_APPROVES}`;
}

/** What Send test message posts (DC6). */
export function testMessage(workspaceName: string): string {
  return `A test message from Vestiarion for **${discordText(workspaceName, 100)}**. Bills the agent holds for approval are posted here. ${NEVER_APPROVES}`;
}
