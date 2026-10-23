import crypto from "node:crypto";
import type { OrgMembership } from "../auth/membership";
import { platformDb } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";

/**
 * An accountant's client invite links (docs/superpowers/specs/2026-10-23-accountant-client-links-design.md). An
 * accountant makes a one-time link on the accountant console; the client opens it signed in, names a workspace, and the
 * workspace opens on Arc testnet in shadow mode with the accountant already in it as accountant.
 *
 * Every change goes through a service-role function of migration 0143, which is told who is acting and checks it
 * itself. Only a link's SHA-256 is kept, and a token never leaves this module but in the link shown once. Making and
 * revoking a link is signed nowhere: no workspace exists yet, and the link's row keeps who made it and when. The
 * accountant joining is signed in the new workspace only, never in any of the accountant's others.
 *
 * Production runs ahead of its migrations: until 0143 runs, the table and functions are missing (42P01, PGRST205,
 * 42883, PGRST202), and every read here says the feature is not available yet rather than fail.
 */

/** How long a link works (AC1). */
export const CLIENT_LINK_DAYS = 7;
/** Open links one accountant may hold at once, and links one may make a day (AC1), as migration 0143 counts them. */
export const MAX_OPEN_CLIENT_LINKS = 10;
export const MAX_CLIENT_LINKS_A_DAY = 20;
/** The most links the console lists, newest first. */
export const CLIENT_LINKS_LISTED = 25;

/** What `org_created` says opened a workspace from a link (AC3). */
export const CLIENT_LINK_VIA = "accountant_link";
/** The console's `?accountant=` when the client's workspace opened and their accountant was not added (AC3). */
export const ACCOUNTANT_NOT_ADDED = "not-added";

const TOKEN = /^vxj_([A-Za-z0-9_-]{43})$/;
const HASH = /^[0-9a-f]{64}$/;

const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

/** A new link's token and the hash kept of it: `vxj_` and 32 random bytes, base64url. */
export function generateClientLinkToken(random: (n: number) => Buffer = crypto.randomBytes): { token: string; tokenHash: string } {
  const secret = random(32).toString("base64url");
  return { token: `vxj_${secret}`, tokenHash: sha256hex(secret) };
}

/** The hash a token is looked up by, or null for anything that is not one. */
export function clientLinkTokenHash(token: unknown): string | null {
  const match = typeof token === "string" ? TOKEN.exec(token) : null;
  return match ? sha256hex(match[1]) : null;
}

export function clientLinkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/join/${token}`;
}

/** Whether a row's hash is the one asked for, compared in constant time: the row is trusted only then. */
export function sameTokenHash(stored: string, asked: string): boolean {
  if (!HASH.test(stored) || !HASH.test(asked)) return false;
  return crypto.timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(asked, "hex"));
}

/** Postgres's or PostgREST's "no such table or function": migration 0143 has not run here yet. */
export function clientLinksMissing(error: { code?: string | null } | null | undefined): boolean {
  return ["42P01", "42883", "PGRST202", "PGRST205"].includes(error?.code ?? "");
}

export type ClientLinkErrorCode =
  | "not_ready" | "not_an_accountant" | "invalid_email" | "client_link_limit_reached" | "client_link_rate_limited"
  | "client_link_not_found" | "client_link_used" | "client_link_expired" | "own_client_link" | "client_link_email_mismatch"
  | "not_owner" | "already_a_member";

export const CLIENT_LINK_MESSAGES: Record<ClientLinkErrorCode, string> = {
  not_ready: "Client invite links are not available yet.",
  not_an_accountant: "Only someone who is an accountant in a workspace can invite a client.",
  invalid_email: "That does not look like an email address.",
  client_link_limit_reached: `You already have ${MAX_OPEN_CLIENT_LINKS} open client links. Revoke one first.`,
  client_link_rate_limited: `You have made ${MAX_CLIENT_LINKS_A_DAY} client links in the last 24 hours. Try again tomorrow.`,
  client_link_not_found: "This link is not valid.",
  client_link_used: "This link has already been used.",
  client_link_expired: "This link has expired. Ask your accountant for a new one.",
  own_client_link: "This is your own client link. Send it to your client.",
  client_link_email_mismatch: "This link was made for a different email address. Sign in with that address to use it.",
  not_owner: "Only the owner who created the workspace can add their accountant this way.",
  already_a_member: "Your accountant is already a member of this workspace.",
};

export class ClientLinkError extends Error {
  constructor(readonly code: ClientLinkErrorCode) {
    super(CLIENT_LINK_MESSAGES[code]);
    this.name = "ClientLinkError";
  }
}

function errorFrom(error: { code?: string | null; message: string }): Error {
  if (clientLinksMissing(error)) return new ClientLinkError("not_ready");
  const code = /^([a-z_]+):/.exec(error.message)?.[1];
  return code && code in CLIENT_LINK_MESSAGES ? new ClientLinkError(code as ClientLinkErrorCode) : new Error(error.message);
}

/** Whether this person may make client links: an accountant in at least one workspace (AC1), as migration 0143 checks. */
export function mayInviteClients(memberships: readonly Pick<OrgMembership, "role">[]): boolean {
  return memberships.some((membership) => membership.role === "accountant");
}

/** The row `create_client_link` and `revoke_client_link` return (migration 0143). */
interface LinkRow {
  id: string;
  email: string | null;
  expires_at: string;
}

/**
 * Makes a link for the accountant `actorId`, bound to `email` when one is given (AC1). The link is returned once, to be
 * shown once; only its hash is sent. Nothing is logged: neither the token nor the address.
 */
export async function createClientLink(input: { actorId: string; email: string; origin: string }): Promise<{ id: string; link: string; email: string | null; expiresAt: string }> {
  const { token, tokenHash } = generateClientLinkToken();
  const result = await platformDb()
    .rpc("create_client_link", { p_actor: input.actorId, p_email: input.email.trim() || null, p_token_hash: tokenHash })
    .single<LinkRow>();
  if (result.error) throw errorFrom(result.error);
  const row = result.data as LinkRow;
  return { id: row.id, link: clientLinkUrl(input.origin, token), email: row.email, expiresAt: row.expires_at };
}

/** Revokes one of the accountant's own open links (AC1). */
export async function revokeClientLink(input: { actorId: string; linkId: string }): Promise<void> {
  const result = await platformDb().rpc("revoke_client_link", { p_actor: input.actorId, p_link_id: input.linkId }).single<LinkRow>();
  if (result.error) throw errorFrom(result.error);
}

export type ClientLinkState = "open" | "used" | "expired" | "revoked";

export interface ClientLink {
  id: string;
  /** The client's address it is bound to, or null for anyone signed in. */
  email: string | null;
  state: ClientLinkState;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  /** The workspace it opened, while the accountant is still a member of it; null otherwise. */
  workspace: string | null;
}

type ListedRow = {
  id: string;
  email: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  org_id: string | null;
  orgs: { name: string } | null;
};

function stateOf(row: Pick<ListedRow, "expires_at" | "used_at" | "revoked_at">, now: Date): ClientLinkState {
  if (row.revoked_at !== null) return "revoked";
  if (row.used_at !== null) return "used";
  return new Date(row.expires_at) <= now ? "expired" : "open";
}

/**
 * The accountant's links for the console, newest first, and whether any was ever used (the checklist's optional step,
 * AC6). A used link names its workspace only while the accountant is still a member of it: once the client removed them,
 * or deleted it, it names none. Before migration 0143, `available` is false and there is nothing.
 */
export async function listClientLinks(
  userId: string,
  memberships: readonly Pick<OrgMembership, "orgId">[],
  now: Date = new Date()
): Promise<{ available: boolean; links: ClientLink[]; everUsed: boolean }> {
  const result = await platformDb()
    .from("accountant_client_links")
    .select("id, email, created_at, expires_at, used_at, revoked_at, org_id, orgs(name)")
    .eq("created_by", userId)
    .order("created_at", { ascending: false })
    .limit(CLIENT_LINKS_LISTED);
  if (result.error) {
    if (clientLinksMissing(result.error)) return { available: false, links: [], everUsed: false };
    throw new Error(result.error.message);
  }
  const member = new Set(memberships.map((membership) => membership.orgId));
  const links = ((result.data ?? []) as unknown as ListedRow[]).map(
    (row): ClientLink => ({
      id: row.id,
      email: row.email,
      state: stateOf(row, now),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      workspace: row.org_id && member.has(row.org_id) ? (row.orgs?.name ?? null) : null,
    })
  );
  let everUsed = links.some((link) => link.state === "used");
  // A used link older than the list shows still counts.
  if (!everUsed && links.length === CLIENT_LINKS_LISTED) {
    const older = await platformDb().from("accountant_client_links").select("id").eq("created_by", userId).not("used_at", "is", null).limit(1);
    if (older.error) throw new Error(older.error.message);
    everUsed = (older.data ?? []).length > 0;
  }
  return { available: true, links, everUsed };
}

/** What a link is, for the client's page (AC2): an open link names its accountant; any other names nothing. */
export type ClientLinkPreview =
  | { state: "not_ready" }
  | { state: "invalid" }
  | { state: "used" }
  | { state: "expired" }
  | { state: "open"; linkId: string; accountantId: string; accountantEmail: string; boundEmail: string | null };

type PreviewRow = {
  link_id: string | null;
  state: ClientLinkState;
  accountant_id: string | null;
  accountant_email: string | null;
  bound_email: string | null;
  token_hash: string;
};

/** What `token` opens, read without a side effect. A revoked link reads as an unknown one, as a withdrawn invitation does. */
export async function clientLinkPreview(token: string): Promise<ClientLinkPreview> {
  const tokenHash = clientLinkTokenHash(token);
  if (!tokenHash) return { state: "invalid" };
  const result = await platformDb().rpc("client_link_preview", { p_token_hash: tokenHash });
  if (result.error) {
    if (clientLinksMissing(result.error)) return { state: "not_ready" };
    throw new Error(result.error.message);
  }
  const row = ((result.data ?? []) as PreviewRow[])[0];
  if (!row || !sameTokenHash(row.token_hash, tokenHash)) return { state: "invalid" };
  if (row.state === "used" || row.state === "expired") return { state: row.state };
  if (row.state !== "open" || !row.link_id || !row.accountant_id || !row.accountant_email) return { state: "invalid" };
  return { state: "open", linkId: row.link_id, accountantId: row.accountant_id, accountantEmail: row.accountant_email, boundEmail: row.bound_email };
}

/**
 * What the client's page offers the signed-in person (AC2): the form for an open link of someone else's, bound to
 * their address or to none; for a link bound to another address, only that it is; for the accountant's own link, only
 * that it is theirs.
 */
export type JoinView =
  | { kind: "not_ready" }
  | { kind: "invalid" }
  | { kind: "used" }
  | { kind: "expired" }
  | { kind: "bound_elsewhere" }
  | { kind: "own" }
  | { kind: "open"; accountantEmail: string };

/** What the page and the action say for each view that offers nothing (AC2): one sentence, naming no one. */
export const JOIN_REFUSALS: Record<Exclude<JoinView["kind"], "open">, string> = {
  not_ready: CLIENT_LINK_MESSAGES.not_ready,
  invalid: CLIENT_LINK_MESSAGES.client_link_not_found,
  used: CLIENT_LINK_MESSAGES.client_link_used,
  expired: CLIENT_LINK_MESSAGES.client_link_expired,
  bound_elsewhere: CLIENT_LINK_MESSAGES.client_link_email_mismatch,
  own: CLIENT_LINK_MESSAGES.own_client_link,
};

export function joinView(preview: ClientLinkPreview, user: { id: string; email: string | null }): JoinView {
  if (preview.state !== "open") return { kind: preview.state };
  if (preview.accountantId === user.id) return { kind: "own" };
  if (preview.boundEmail !== null && preview.boundEmail !== (user.email ?? "").trim().toLowerCase()) return { kind: "bound_elsewhere" };
  return { kind: "open", accountantEmail: preview.accountantEmail };
}

/** The row `claim_client_link` returns (migration 0143). */
interface ClaimRow {
  link_id: string;
  accountant_id: string;
}

/**
 * Adds the link's accountant to the client's workspace `orgId`, made a moment before by `createWorkspace` (AC3). The
 * function checks the link, the client's ownership and that the accountant is not the client; the role is always
 * accountant. The accountant's `member_joined` is then signed in that workspace alone, best effort, as an accepted
 * invitation's is.
 */
export async function claimClientLink(input: { tokenHash: string; userId: string; orgId: string }): Promise<{ linkId: string; accountantId: string }> {
  const result = await platformDb()
    .rpc("claim_client_link", { p_token_hash: input.tokenHash, p_user_id: input.userId, p_org_id: input.orgId })
    .single<ClaimRow>();
  if (result.error) throw errorFrom(result.error);
  const row = result.data as ClaimRow;
  await appendLedgerEntryBestEffort(
    input.orgId,
    {
      actor: "human",
      domain: "system",
      action: "member_joined",
      summary: "A member joined with the accountant role",
      detail: { by: row.accountant_id, role: "accountant", clientLinkId: row.link_id, grantedBy: input.userId },
    },
    { enterScope: { userId: input.userId } }
  );
  return { linkId: row.link_id, accountantId: row.accountant_id };
}
