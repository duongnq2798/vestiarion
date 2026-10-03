import crypto from "node:crypto";
import { memberActor, type Actor } from "../commands/actor";
import { currentOrgId } from "../context";
import { platformDb, unwrap } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import type { SlackInstall } from "./installs";

/**
 * A member's own Slack account, linked to their membership (Slack design S4, S5), in platform rows the service role
 * alone reads and writes (migration 0067). `/vestiarion connect` makes a one-time code, of which only the SHA-256 is
 * kept, bound to the Slack account that asked; the member signs in and connects, and the database's own function uses
 * the code up and makes the link. Every action then builds its actor from the membership as it is now.
 */

/** How long a code from `/vestiarion connect` works. */
export const LINK_REQUEST_TTL_MS = 10 * 60_000;

/** 32 random bytes in base64url. */
const CODE = /^[A-Za-z0-9_-]{43}$/;

export interface SlackLink {
  id: string;
  orgId: string;
  userId: string;
  teamId: string;
  slackUserId: string;
  linkedAt: string;
}

interface LinkRow {
  id: string;
  org_id: string;
  user_id: string;
  team_id: string;
  slack_user_id: string;
  linked_at: string;
}

const COLUMNS = "id, org_id, user_id, team_id, slack_user_id, linked_at";

const toLink = (row: LinkRow): SlackLink => ({
  id: row.id,
  orgId: row.org_id,
  userId: row.user_id,
  teamId: row.team_id,
  slackUserId: row.slack_user_id,
  linkedAt: row.linked_at,
});

const hashOf = (code: string) => crypto.createHash("sha256").update(code).digest("hex");

/** A code for the Slack account that typed `/vestiarion connect`, working once, for ten minutes; only its hash is kept. */
export async function createLinkRequest(
  teamId: string,
  slackUserId: string,
  slackUserName: string | null,
  now: Date = new Date()
): Promise<{ code: string; expiresAt: string }> {
  const code = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + LINK_REQUEST_TTL_MS).toISOString();
  // A used or expired request does nothing more, so each new one clears them, and no Slack name is kept past its use for
  // long. Best effort: a request that could not be cleared waits for the next.
  const cleared = await platformDb()
    .from("slack_link_requests")
    .delete()
    .or(`used_at.not.is.null,expires_at.lt.${now.toISOString()}`);
  if (cleared.error) console.error("slack: old connect requests not cleared", cleared.error.message);
  unwrap(
    await platformDb()
      .from("slack_link_requests")
      .insert({
        team_id: teamId,
        slack_user_id: slackUserId,
        slack_user_name: slackUserName ? slackUserName.slice(0, 100) : null,
        code_hash: hashOf(code),
        expires_at: expiresAt,
      })
      .select("id")
  );
  return { code, expiresAt };
}

/** Who a code was made for, while it is unused and unexpired; a string that is not a code asks the database nothing. */
export async function readLinkRequest(
  code: string,
  now: Date = new Date()
): Promise<{ teamId: string; slackUserId: string; slackUserName: string | null } | null> {
  if (!CODE.test(code)) return null;
  const rows = unwrap(
    await platformDb()
      .from("slack_link_requests")
      .select("team_id, slack_user_id, slack_user_name")
      .eq("code_hash", hashOf(code))
      .is("used_at", null)
      .gt("expires_at", now.toISOString())
      .limit(1)
  ) as Array<{ team_id: string; slack_user_id: string; slack_user_name: string | null }>;
  const row = rows[0];
  return row ? { teamId: row.team_id, slackUserId: row.slack_user_id, slackUserName: row.slack_user_name } : null;
}

/** Entries about a link belong to its own workspace's ledger, and nowhere else. */
function requireScope(orgId: string): void {
  if (currentOrgId() !== orgId) throw new Error("A Slack link's entry cannot be written to another workspace's ledger");
}

/**
 * Uses the code up and links its Slack account to the member (`slack_link_member`, 0067), replacing an earlier link of
 * either side; records it. Null for a code that is unknown, used, expired, or for another workspace's Slack team.
 * Runs inside the workspace's scope.
 */
export async function linkMember(code: string, orgId: string, userId: string): Promise<SlackLink | null> {
  requireScope(orgId);
  if (!CODE.test(code)) return null;
  const rows = unwrap(await platformDb().rpc("slack_link_member", { p_code_hash: hashOf(code), p_org_id: orgId, p_user_id: userId })) as LinkRow[];
  const link = rows[0] ? toLink(rows[0]) : null;
  if (!link) return null;
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "system",
    action: "slack_member_connected",
    summary: "Connected a member's own Slack account",
    detail: { by: userId, linkId: link.id },
  });
  return link;
}

async function oneLink(filters: Record<string, string>): Promise<SlackLink | null> {
  let query = platformDb().from("slack_links").select(COLUMNS);
  for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
  const rows = unwrap(await query.limit(1)) as LinkRow[];
  return rows[0] ? toLink(rows[0]) : null;
}

/** The member a Slack account is linked to, if any. */
export function linkOf(teamId: string, slackUserId: string): Promise<SlackLink | null> {
  return oneLink({ team_id: teamId, slack_user_id: slackUserId });
}

/** A member's own link, if any. */
export function linkFor(orgId: string, userId: string): Promise<SlackLink | null> {
  return oneLink({ org_id: orgId, user_id: userId });
}

/** Removes a link, from Slack (`/vestiarion disconnect`) or from Settings; records it when a row went. */
export async function unlink(link: SlackLink, via: "slack" | "settings", by: string): Promise<boolean> {
  requireScope(link.orgId);
  const deleted = unwrap(await platformDb().from("slack_links").delete().eq("id", link.id).select("id")) as Array<{ id: string }>;
  if (deleted.length === 0) return false;
  await appendLedgerEntryBestEffort(link.orgId, {
    actor: "human",
    domain: "system",
    action: "slack_member_disconnected",
    summary: "Disconnected a member's own Slack account",
    detail: { by, userId: link.userId, linkId: link.id, via },
  });
  return true;
}

/** The member acting through Slack (S5): their role and the workspace's mode read now, with the install's limit read now. */
export function slackActor(install: SlackInstall, link: SlackLink): Promise<Actor | null> {
  return memberActor(link.orgId, link.userId, { kind: "slack", linkId: link.id, decisionsLimitUsdc: install.decisionsLimitUsdc });
}
