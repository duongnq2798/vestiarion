import crypto from "node:crypto";
import { isOrgRole, type OrgRole } from "../auth/roles";
import { currentOrgId } from "../context";
import { platformDb, unwrap } from "../dal";
import { appendLedgerEntry } from "../ledger";

/**
 * A member's Telegram chat, connected to their membership of a workspace (Telegram bot design R4–R8). Platform rows
 * the service role reads and writes (migration 0064): the one-time codes, the links with their cursors, and the
 * database's own functions that claim a code and switch a chat's workspace atomically.
 */

/** How long a code from the Members page works (R4). */
export const LINK_CODE_TTL_MS = 10 * 60_000;
/** The most links one cycle's stage tells (R8). */
export const LINKS_PER_STAGE = 25;

/** 32 random bytes in base64url: what `createLinkCode` makes, inside Telegram's 64-character `start` limit. */
const CODE = /^[A-Za-z0-9_-]{43}$/;

export interface TelegramLink {
  id: string;
  orgId: string;
  userId: string;
  chatId: number;
  username: string | null;
  active: boolean;
  /** The last ledger entry the chat was told about. */
  notifiedSeq: number;
  linkedAt: string;
}

interface LinkRow {
  id: string;
  org_id: string;
  user_id: string;
  chat_id: number | string;
  username: string | null;
  active: boolean;
  notified_seq: number | string;
  linked_at: string;
}

const COLUMNS = "id, org_id, user_id, chat_id, username, active, notified_seq, linked_at";

const toLink = (row: LinkRow): TelegramLink => ({
  id: row.id,
  orgId: row.org_id,
  userId: row.user_id,
  chatId: Number(row.chat_id),
  username: row.username,
  active: row.active,
  notifiedSeq: Number(row.notified_seq),
  linkedAt: row.linked_at,
});

const hashOf = (code: string) => crypto.createHash("sha256").update(code).digest("hex");

/** A Telegram username as the ledger keeps it: its first two characters (`@li***`), or null for none. */
export function maskUsername(username: string | null): string | null {
  return username ? `@${username.slice(0, 2)}***` : null;
}

/** A code for the Members page's Connect button: random, used once, for ten minutes; only its hash is stored (R4). */
export async function createLinkCode(orgId: string, userId: string, now: Date = new Date()): Promise<{ code: string; expiresAt: string }> {
  const code = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS).toISOString();
  unwrap(
    await platformDb()
      .from("telegram_link_codes")
      .insert({ org_id: orgId, user_id: userId, code_hash: hashOf(code), expires_at: expiresAt })
      .select("id")
  );
  return { code, expiresAt };
}

/**
 * Claims a code for a chat: the membership's link is made, or moved to this chat, and becomes its active one, with its
 * cursor at the workspace's ledger head (`telegram_claim_code`, 0064). Null for a code that is unknown, used or
 * expired; a string that is not a code we make asks the database nothing.
 */
export async function claimLinkCode(code: string, chatId: number, username: string | null): Promise<TelegramLink | null> {
  if (!CODE.test(code)) return null;
  const rows = unwrap(
    await platformDb().rpc("telegram_claim_code", { p_code_hash: hashOf(code), p_chat_id: chatId, p_username: username ? username.slice(0, 64) : null })
  ) as LinkRow[];
  return rows[0] ? toLink(rows[0]) : null;
}

/** The chat's links, its active one first, then the newest. */
export async function linksForChat(chatId: number): Promise<TelegramLink[]> {
  const rows = unwrap(
    await platformDb()
      .from("telegram_links")
      .select(COLUMNS)
      .eq("chat_id", chatId)
      .order("active", { ascending: false })
      .order("linked_at", { ascending: false })
  ) as LinkRow[];
  return rows.map(toLink);
}

/** The workspace the chat's commands and invoices go to (R5), or null for a chat with no link. */
export async function activeLink(chatId: number): Promise<TelegramLink | null> {
  const [first] = await linksForChat(chatId);
  return first?.active ? first : null;
}

/** Makes one of the chat's links its active one (`telegram_activate`, 0064); null when the link is not this chat's. */
export async function activateLink(chatId: number, linkId: string): Promise<TelegramLink | null> {
  const rows = unwrap(await platformDb().rpc("telegram_activate", { p_chat_id: chatId, p_link_id: linkId })) as LinkRow[];
  return rows[0] ? toLink(rows[0]) : null;
}

/** The workspace's links, oldest first, at most `limit` (R8). */
export async function linksForOrg(orgId: string, limit: number = LINKS_PER_STAGE): Promise<TelegramLink[]> {
  const rows = unwrap(
    await platformDb().from("telegram_links").select(COLUMNS).eq("org_id", orgId).order("linked_at", { ascending: true }).limit(limit)
  ) as LinkRow[];
  return rows.map(toLink);
}

/** A member's own link to a workspace, or null. */
export async function linkFor(orgId: string, userId: string): Promise<TelegramLink | null> {
  const rows = unwrap(await platformDb().from("telegram_links").select(COLUMNS).eq("org_id", orgId).eq("user_id", userId).limit(1)) as LinkRow[];
  return rows[0] ? toLink(rows[0]) : null;
}

/** Moves a link's cursor to `seq`, never back (R8). */
export async function moveCursor(linkId: string, seq: number): Promise<void> {
  const result = await platformDb().from("telegram_links").update({ notified_seq: seq }).eq("id", linkId).lt("notified_seq", seq);
  if (result.error) throw new Error(result.error.message);
}

/** A member's role in a workspace, read afresh for every update (R7); null when they are no longer a member. */
export async function memberRole(orgId: string, userId: string): Promise<OrgRole | null> {
  const rows = unwrap(await platformDb().from("memberships").select("role").eq("org_id", orgId).eq("user_id", userId).limit(1)) as Array<{ role: unknown }>;
  const role = rows[0]?.role;
  return isOrgRole(role) ? role : null;
}

/** Ledger entries about a link belong to its own workspace's ledger, and nowhere else. */
function requireLinkScope(link: TelegramLink): void {
  if (currentOrgId() !== link.orgId) throw new Error("A Telegram link's entry cannot be written to another workspace's ledger");
}

/** Records that a member connected a chat (R4). Runs inside the link's workspace's scope. */
export async function recordConnected(link: TelegramLink): Promise<void> {
  requireLinkScope(link);
  await appendLedgerEntry({
    actor: "human",
    domain: "system",
    action: "telegram_connected",
    summary: "Connected a Telegram chat to this workspace",
    detail: { by: link.userId, username: maskUsername(link.username) },
  });
}

/**
 * Removes a link (R6): by its member from the Members page or the chat, or because Telegram answered 403 when the
 * member blocked the bot. Records it when a row went; answers whether one did. Runs inside the link's workspace's scope.
 */
export async function disconnect(link: TelegramLink, via: "members_page" | "telegram" | "blocked", by: string | null): Promise<boolean> {
  requireLinkScope(link);
  const deleted = unwrap(await platformDb().from("telegram_links").delete().eq("id", link.id).select("id")) as Array<{ id: string }>;
  if (deleted.length === 0) return false;
  await appendLedgerEntry({
    actor: via === "blocked" ? "system" : "human",
    domain: "system",
    action: "telegram_disconnected",
    summary: via === "blocked" ? "Disconnected a Telegram chat that blocked the bot" : "Disconnected a Telegram chat from this workspace",
    detail: { by, userId: link.userId, via, username: maskUsername(link.username) },
  });
  return true;
}
