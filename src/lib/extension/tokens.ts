import crypto from "node:crypto";
import { bearerToken } from "../agent-security";
import { can, isOrgRole } from "../auth/roles";
import { currentOrgId, NoOrgScopeError } from "../context";
import { platformDb } from "../dal";
import type { LedgerEntryInput } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { verifierMatches } from "./pkce";
import { EXTENSION_AUDIENCE, EXTENSION_SCOPES, scopeString, type ExtensionScope } from "./settings";

/**
 * The Chrome extension's connections (invoice capture design C12-C17). An extension never holds an API key: a person
 * consents on /extension/authorize, which issues a one-time code (`vxc_…`, five minutes) bound to them, the workspace,
 * the extension, its redirect address and a PKCE challenge; the extension exchanges it for an access token (`vxa_…`,
 * an hour) and a refresh token (`vxr_…`, thirty days, replaced on every refresh). Each is 32 random bytes in
 * base64url, kept only as the SHA-256 of the whole token (migration 0121): a fast hash is right for 256 bits of
 * entropy, as for API keys. A token is never logged, nor written to the ledger; the ledger names the connection's id.
 *
 * A connection acts for a member who can add bills: the role is read again at every exchange and refresh, and the
 * draft endpoints read it at every request (`memberActor`); a role that can no longer add bills ends the connection.
 * Ending the membership deletes it (a foreign key on the membership, cascading). However often it is refreshed, a
 * connection ends 90 days after it was made. A code or a refresh token used again ends the connection it belongs to:
 * the extension never uses either twice. The tables are platform tables: a request names its workspace only through
 * its token, so this module reads them before any workspace is known, and only it does.
 */

export const CODE_TTL_MS = 5 * 60_000;
export const ACCESS_TTL_SECONDS = 3600;
export const REFRESH_TTL_MS = 30 * 86_400_000;
/** The longest a connection lasts, from its making, whatever its refreshes (C15). */
export const CONNECTION_LIFETIME_MS = 90 * 86_400_000;
/** `last_used_at` is refreshed at most once a minute, as an API key's is. */
const TOUCH_INTERVAL_MS = 60_000;

const TOKEN = /^(vxa|vxr|vxc)_[A-Za-z0-9_-]{43}$/;
const KINDS = { vxa: "access", vxr: "refresh", vxc: "code" } as const;
type TokenKind = (typeof KINDS)[keyof typeof KINDS];

/** Before migration 0121, the tables are not there: invoice capture is not set up (C22). */
export class CaptureNotSetUpError extends Error {
  constructor() {
    super("Invoice capture is not set up on this deployment yet");
    this.name = "CaptureNotSetUpError";
  }
}

/** PostgREST's "no such table" or "no such function", or Postgres's own. */
export function isMissingRelation(error: { code?: string | null; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return ["PGRST205", "PGRST202", "42P01", "42883"].includes(error.code ?? "");
}

function raise(error: { code?: string | null; message: string }): never {
  if (isMissingRelation(error)) throw new CaptureNotSetUpError();
  throw new Error(error.message);
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}

export function newToken(prefix: "vxa" | "vxr" | "vxc", random: (n: number) => Buffer = crypto.randomBytes): { token: string; hash: string } {
  const token = `${prefix}_${random(32).toString("base64url")}`;
  return { token, hash: sha256Hex(token) };
}

/** What a string is, by its form alone; null for anything that is not one of the extension's tokens. */
export function tokenKind(token: unknown): TokenKind | null {
  if (typeof token !== "string" || !TOKEN.test(token)) return null;
  return KINDS[token.slice(0, 3) as keyof typeof KINDS];
}

function isScope(value: unknown): value is ExtensionScope {
  return typeof value === "string" && (EXTENSION_SCOPES as readonly string[]).includes(value);
}

/** The ledger entry goes into the workspace's own scope: the one already entered, or entered for the append alone. */
function ledgerScope(orgId: string, userId: string): { enterScope?: { userId: string } } {
  let scoped: string | null;
  try {
    scoped = currentOrgId();
  } catch (error) {
    if (!(error instanceof NoOrgScopeError)) throw error;
    scoped = null;
  }
  return scoped === orgId ? {} : { enterScope: { userId } };
}

function record(orgId: string, userId: string, entry: LedgerEntryInput): Promise<void> {
  return appendLedgerEntryBestEffort(orgId, entry, ledgerScope(orgId, userId));
}

/** An OAuth error code (RFC 6749 §5.2, RFC 8707 for the audience) and words the extension can show. */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_target"
  | "temporarily_unavailable";

export interface IssuedTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
  audience: typeof EXTENSION_AUDIENCE;
  /** The workspace the tokens act in, for the extension to show. */
  workspace: { name: string; slug: string };
}

export type TokenOutcome = { ok: true; tokens: IssuedTokens } | { ok: false; error: OAuthErrorCode; description: string };

const refusal = (error: OAuthErrorCode, description: string): TokenOutcome => ({ ok: false, error, description });
const INVALID_CODE = "The code is unknown, has expired or was already used. Connect again.";

/** Whether the person may connect an extension to this workspace, as their role is now: an owner or admin. */
async function mayCapture(orgId: string, userId: string): Promise<boolean> {
  const membership = await platformDb().from("memberships").select("role").eq("org_id", orgId).eq("user_id", userId).maybeSingle<{ role: unknown }>();
  if (membership.error) throw new Error(membership.error.message);
  const role = membership.data?.role;
  return isOrgRole(role) && can(role, "records.write");
}

/** The workspace's name and slug, which the extension shows and its links name. */
export async function workspaceOf(orgId: string): Promise<{ name: string; slug: string }> {
  const org = await platformDb().from("orgs").select("name, slug").eq("id", orgId).single<{ name: string; slug: string }>();
  if (org.error) throw new Error(org.error.message);
  return { name: org.data.name, slug: org.data.slug };
}

/** A new pair, neither outliving the connection's end (`endsAt`, its making plus 90 days). */
function pair(now: Date, endsAt: number) {
  const access = newToken("vxa");
  const refresh = newToken("vxr");
  const accessEnds = Math.min(now.getTime() + ACCESS_TTL_SECONDS * 1000, endsAt);
  return {
    access,
    refresh,
    expiresIn: Math.max(0, Math.floor((accessEnds - now.getTime()) / 1000)),
    columns: {
      access_token_hash: access.hash,
      access_expires_at: new Date(accessEnds).toISOString(),
      refresh_token_hash: refresh.hash,
      refresh_expires_at: new Date(Math.min(now.getTime() + REFRESH_TTL_MS, endsAt)).toISOString(),
    },
  };
}

function issued(tokens: ReturnType<typeof pair>, scopes: ExtensionScope[], workspace: { name: string; slug: string }): IssuedTokens {
  return {
    access_token: tokens.access.token,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refresh.token,
    scope: scopeString(scopes),
    audience: EXTENSION_AUDIENCE,
    workspace,
  };
}

/**
 * Issues the one-time code a person's consent gives (C13), bound to them, the workspace, the extension, its redirect
 * address, the PKCE challenge and the scopes. Returns the code itself, which only this answer holds.
 */
export async function issueAuthorizationCode(input: {
  orgId: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: ExtensionScope[];
  now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date();
  const { token, hash } = newToken("vxc");
  const { error } = await platformDb()
    .from("extension_auth_codes")
    .insert({
      code_hash: hash,
      org_id: input.orgId,
      user_id: input.userId,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      scopes: input.scopes,
      expires_at: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
    });
  if (error) raise(error);
  return token;
}

/**
 * A code presented after it was used: it is marked, and the connection made with it, which carries the code's hash, is
 * ended, as OAuth advises (C14). The mark ends a connection still being made too: the exchange looks for it once its
 * connection is written. A code never exchanged, or unknown, changes nothing.
 */
async function revokeAfterReuse(hash: string, now: Date): Promise<void> {
  const marked = await platformDb()
    .from("extension_auth_codes")
    .update({ replayed_at: now.toISOString() })
    .eq("code_hash", hash)
    .not("used_at", "is", null)
    .is("replayed_at", null);
  if (marked.error) raise(marked.error);
  const found = await platformDb()
    .from("extension_grants")
    .select("id, org_id")
    .eq("code_hash", hash)
    .is("revoked_at", null)
    .maybeSingle<{ id: string; org_id: string }>();
  if (found.error) raise(found.error);
  if (found.data) await revokeConnection({ orgId: found.data.org_id, connectionId: found.data.id, by: null, reason: "reused_code" });
}

/** Whether the code was presented again since it was used (`revokeAfterReuse`'s mark). */
async function codeReplayed(hash: string): Promise<boolean> {
  const found = await platformDb().from("extension_auth_codes").select("replayed_at").eq("code_hash", hash).maybeSingle<{ replayed_at: string | null }>();
  if (found.error) raise(found.error);
  return Boolean(found.data?.replayed_at);
}

/**
 * A refresh token used again after it was replaced: the connection it belongs to is ended (C15), as OAuth's advice on
 * rotating refresh tokens has it. The extension refreshes from its service worker alone, one refresh at a time, so its
 * own use never looks like this.
 */
async function revokeAfterRefreshReuse(hash: string): Promise<void> {
  const found = await platformDb()
    .from("extension_grants")
    .select("id, org_id")
    .eq("retired_refresh_hash", hash)
    .is("revoked_at", null)
    .maybeSingle<{ id: string; org_id: string }>();
  if (found.error) raise(found.error);
  if (found.data) await revokeConnection({ orgId: found.data.org_id, connectionId: found.data.id, by: null, reason: "reused_refresh" });
}

interface ClaimedCode {
  org_id: string;
  user_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
}

/**
 * Exchanges a code for tokens (C14). The code is used up first, in one guarded update, so it works once whatever the
 * outcome: a wrong verifier, client or redirect address spends it too. Then everything it was bound to is compared,
 * and the person's role is read again.
 */
export async function exchangeAuthorizationCode(input: {
  code: unknown;
  verifier: unknown;
  clientId: string;
  redirectUri: unknown;
  now?: Date;
}): Promise<TokenOutcome> {
  const now = input.now ?? new Date();
  if (tokenKind(input.code) !== "code") return refusal("invalid_grant", INVALID_CODE);
  const hash = sha256Hex(input.code as string);
  const nowIso = now.toISOString();
  const claimed = await platformDb()
    .from("extension_auth_codes")
    .update({ used_at: nowIso })
    .eq("code_hash", hash)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .select("org_id, user_id, client_id, redirect_uri, code_challenge, scopes");
  if (claimed.error) raise(claimed.error);
  const code = (claimed.data as ClaimedCode[])[0];
  if (!code) {
    await revokeAfterReuse(hash, now);
    return refusal("invalid_grant", INVALID_CODE);
  }
  if (code.client_id !== input.clientId || code.redirect_uri !== input.redirectUri) {
    return refusal("invalid_grant", "The code was issued to another extension or redirect address.");
  }
  if (!verifierMatches(input.verifier, code.code_challenge)) return refusal("invalid_grant", "The code verifier does not match the challenge.");
  if (!(await mayCapture(code.org_id, code.user_id))) {
    return refusal("invalid_grant", "You can no longer add bills in this workspace. Ask an owner, then connect again.");
  }

  // Read before the connection exists, so a failure here leaves no connection whose tokens nobody received.
  const workspace = await workspaceOf(code.org_id);
  const scopes = code.scopes.filter(isScope);
  const tokens = pair(now, now.getTime() + CONNECTION_LIFETIME_MS);
  // The code's hash goes in with the connection, in the one insert, so a code presented again always finds it.
  const created = await platformDb()
    .from("extension_grants")
    .insert({
      org_id: code.org_id,
      user_id: code.user_id,
      client_id: code.client_id,
      audience: EXTENSION_AUDIENCE,
      scopes,
      code_hash: hash,
      ...tokens.columns,
      created_at: nowIso,
      last_used_at: nowIso,
    })
    .select("id")
    .single<{ id: string }>();
  if (created.error) raise(created.error);

  await record(code.org_id, code.user_id, {
    actor: "human",
    domain: "system",
    action: "extension_connected",
    summary: "Connected the Chrome extension Vestiarion Invoice Capture",
    detail: { by: code.user_id, connectionId: created.data.id, client: code.client_id, scopes },
  });
  // The same code presented again while this connection was being made found nothing to end: it is ended now.
  if (await codeReplayed(hash)) {
    await revokeConnection({ orgId: code.org_id, connectionId: created.data.id, by: null, reason: "reused_code" });
    return refusal("invalid_grant", INVALID_CODE);
  }
  return { ok: true, tokens: issued(tokens, scopes, workspace) };
}

interface GrantRow {
  id: string;
  org_id: string;
  user_id: string;
  client_id: string;
  audience: string;
  scopes: string[];
}

const INVALID_REFRESH = "The refresh token is not valid. Connect again.";
const NO_LONGER_ALLOWED = "You can no longer add bills in this workspace. Ask an owner, then connect again.";

/**
 * A new access token and refresh token for a refresh token still valid; the old pair stops at once (C15). Neither
 * outlives the connection's 90 days. A person who can no longer add bills ends the connection; so does a refresh token
 * used again, after it was replaced or by two refreshes at once.
 */
export async function refreshExtensionTokens(input: { refreshToken: unknown; clientId: string; now?: Date }): Promise<TokenOutcome> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  if (tokenKind(input.refreshToken) !== "refresh") return refusal("invalid_grant", INVALID_REFRESH);
  const hash = sha256Hex(input.refreshToken as string);
  const found = await platformDb()
    .from("extension_grants")
    .select("id, org_id, user_id, client_id, audience, scopes, created_at")
    .eq("refresh_token_hash", hash)
    .is("revoked_at", null)
    .gt("refresh_expires_at", nowIso)
    .maybeSingle<GrantRow & { created_at: string }>();
  if (found.error) raise(found.error);
  const grant = found.data;
  if (!grant) {
    await revokeAfterRefreshReuse(hash);
    return refusal("invalid_grant", INVALID_REFRESH);
  }
  const endsAt = Date.parse(grant.created_at) + CONNECTION_LIFETIME_MS;
  if (grant.client_id !== input.clientId || !(endsAt > now.getTime())) return refusal("invalid_grant", INVALID_REFRESH);
  if (!(await mayCapture(grant.org_id, grant.user_id))) {
    await revokeConnection({ orgId: grant.org_id, connectionId: grant.id, by: null, reason: "role_changed" });
    return refusal("invalid_grant", NO_LONGER_ALLOWED);
  }
  // Read before the pair is replaced, as an exchange does: a failure here leaves the extension's refresh token working,
  // where one after the update would leave it holding a retired token whose next use ends the connection.
  const workspace = await workspaceOf(grant.org_id);
  const tokens = pair(now, endsAt);
  // Guarded on the old hash: two refreshes with one token give one new pair, and the other ends the connection.
  const rotated = await platformDb()
    .from("extension_grants")
    .update({ ...tokens.columns, retired_refresh_hash: hash, refreshed_at: nowIso, last_used_at: nowIso })
    .eq("id", grant.id)
    .eq("refresh_token_hash", hash)
    .is("revoked_at", null)
    .select("id");
  if (rotated.error) raise(rotated.error);
  if ((rotated.data as Array<{ id: string }>).length === 0) {
    await revokeConnection({ orgId: grant.org_id, connectionId: grant.id, by: null, reason: "reused_refresh" });
    return refusal("invalid_grant", INVALID_REFRESH);
  }
  return { ok: true, tokens: issued(tokens, grant.scopes.filter(isScope), workspace) };
}

/** Who a request acts for, through which connection, with what it was granted (C16). */
export interface ExtensionPrincipal {
  connectionId: string;
  orgId: string;
  userId: string;
  clientId: string;
  audience: string;
  scopes: ExtensionScope[];
  accessExpiresAt: string;
  lastUsedAt: string | null;
}

interface PrincipalRow extends GrantRow {
  access_expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

/**
 * The connection an access token belongs to, or null for a missing, malformed, unknown, expired or revoked one (the
 * same 401 for each). An API key (`vxk_…`) is not an access token. A database error is not a verdict on the token, so
 * it throws; before migration 0121, `CaptureNotSetUpError`.
 */
export async function authenticateExtensionToken(authorization: string | null, now: Date = new Date()): Promise<ExtensionPrincipal | null> {
  const token = bearerToken(authorization);
  if (tokenKind(token) !== "access") return null;
  const found = await platformDb()
    .from("extension_grants")
    .select("id, org_id, user_id, client_id, audience, scopes, access_expires_at, revoked_at, last_used_at")
    .eq("access_token_hash", sha256Hex(token as string))
    .maybeSingle<PrincipalRow>();
  if (found.error) raise(found.error);
  const row = found.data;
  if (!row || row.revoked_at !== null || Date.parse(row.access_expires_at) <= now.getTime()) return null;
  return {
    connectionId: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    clientId: row.client_id,
    audience: row.audience,
    scopes: row.scopes.filter(isScope),
    accessExpiresAt: row.access_expires_at,
    lastUsedAt: row.last_used_at,
  };
}

/** Records the connection's use, at most once a minute. Never throws. */
export async function touchConnection(principal: ExtensionPrincipal, now: Date = new Date()): Promise<void> {
  if (principal.lastUsedAt && now.getTime() - Date.parse(principal.lastUsedAt) < TOUCH_INTERVAL_MS) return;
  try {
    const { error } = await platformDb().from("extension_grants").update({ last_used_at: now.toISOString() }).eq("id", principal.connectionId);
    if (error) console.error("an extension connection's last use was not recorded", error.message);
  } catch (error) {
    console.error("an extension connection's last use was not recorded", error instanceof Error ? error.message : "unknown error");
  }
}

/**
 * Why a connection ended: its own Disconnect, Settings, a code or a refresh token used again, or a role that can no
 * longer add bills. A membership that ends deletes its connections, recorded by `memberConnectionEnded`.
 */
export type RevokeReason = "extension" | "settings" | "reused_code" | "reused_refresh" | "role_changed";

/**
 * Ends one connection of this workspace (C17): its tokens stop at once. False when there was none still active. The
 * ledger records `extension_disconnected` with the connection's id, never a token.
 */
export async function revokeConnection(input: { orgId: string; connectionId: string; by: string | null; reason: RevokeReason }): Promise<boolean> {
  const revoked = await platformDb()
    .from("extension_grants")
    .update({ revoked_at: new Date().toISOString(), revoked_by: input.by, revoked_reason: input.reason })
    .eq("id", input.connectionId)
    .eq("org_id", input.orgId)
    .is("revoked_at", null)
    .select("id, user_id, client_id");
  if (revoked.error) raise(revoked.error);
  const row = (revoked.data as Array<{ id: string; user_id: string; client_id: string }>)[0];
  if (!row) return false;
  await record(input.orgId, input.by ?? row.user_id, {
    actor: "human",
    domain: "system",
    action: "extension_disconnected",
    summary: "Disconnected the Chrome extension Vestiarion Invoice Capture",
    detail: { by: input.by, connectionId: row.id, client: row.client_id, reason: input.reason },
  });
  return true;
}

/**
 * The extension's own Disconnect (RFC 7009): its access or refresh token ends its connection. Anything else, or a
 * token of another extension, changes nothing, and the caller answers 200 either way.
 */
export async function revokeExtensionToken(input: { token: unknown; clientId: string }): Promise<void> {
  const kind = tokenKind(input.token);
  if (kind !== "access" && kind !== "refresh") return;
  const column = kind === "access" ? "access_token_hash" : "refresh_token_hash";
  const found = await platformDb()
    .from("extension_grants")
    .select("id, org_id, user_id, client_id")
    .eq(column, sha256Hex(input.token as string))
    .is("revoked_at", null)
    .maybeSingle<{ id: string; org_id: string; user_id: string; client_id: string }>();
  if (found.error) raise(found.error);
  if (!found.data || found.data.client_id !== input.clientId) return;
  await revokeConnection({ orgId: found.data.org_id, connectionId: found.data.id, by: found.data.user_id, reason: "extension" });
}

/** A connected extension, as Settings lists it (C17). */
export interface ExtensionConnection {
  id: string;
  userId: string;
  clientId: string;
  connectedAt: string;
  lastUsedAt: string | null;
}

/**
 * The workspace's connections still active, newest first: one person's, or everyone's for an owner or admin. Before
 * migration 0121, `{ available: false }`.
 */
export async function listConnections(orgId: string, options: { userId?: string } = {}): Promise<{ available: true; connections: ExtensionConnection[] } | { available: false }> {
  let query = platformDb()
    .from("extension_grants")
    .select("id, user_id, client_id, created_at, last_used_at")
    .eq("org_id", orgId)
    .is("revoked_at", null)
    .gt("refresh_expires_at", new Date().toISOString());
  if (options.userId) query = query.eq("user_id", options.userId);
  const listed = await query.order("created_at", { ascending: false }).limit(50);
  if (listed.error) {
    if (isMissingRelation(listed.error)) return { available: false };
    throw new Error(listed.error.message);
  }
  const rows = listed.data as Array<{ id: string; user_id: string; client_id: string; created_at: string; last_used_at: string | null }>;
  return {
    available: true,
    connections: rows.map((row) => ({ id: row.id, userId: row.user_id, clientId: row.client_id, connectedAt: row.created_at, lastUsedAt: row.last_used_at })),
  };
}

/** The connection's owner, for Settings' check that a person disconnects only their own unless they manage integrations. */
export async function connectionOwner(orgId: string, connectionId: string): Promise<string | null> {
  const found = await platformDb().from("extension_grants").select("user_id").eq("org_id", orgId).eq("id", connectionId).maybeSingle<{ user_id: string }>();
  if (found.error) raise(found.error);
  return found.data?.user_id ?? null;
}

/** A connection that ending a membership deletes with it (the foreign key's cascade), as its ledger entry names it. */
export interface MemberConnection {
  id: string;
  orgId: string;
  clientId: string;
}

/**
 * The person's active connections, in one workspace or in every one, read before a membership or an account ends and
 * deletes them, leaving no row to say why. Best effort: before migration 0121, or when they cannot be read, none, and
 * nothing is refused because of it.
 */
export async function activeConnectionsOf(userId: string, orgId?: string): Promise<MemberConnection[]> {
  try {
    let query = platformDb().from("extension_grants").select("id, org_id, client_id").eq("user_id", userId).is("revoked_at", null);
    if (orgId) query = query.eq("org_id", orgId);
    const { data, error } = await query;
    if (error) {
      if (!isMissingRelation(error)) console.error("a member's extension connections were not read", error.message);
      return [];
    }
    return (data as Array<{ id: string; org_id: string; client_id: string }>).map((row) => ({ id: row.id, orgId: row.org_id, clientId: row.client_id }));
  } catch (error) {
    console.error("a member's extension connections were not read", error instanceof Error ? error.message : "unknown error");
    return [];
  }
}

/** How a membership ended, for the entry of each connection it took with it. */
export type MembershipEnd = "member_removed" | "member_left" | "account_deleted";

/** The `extension_disconnected` entry of a connection deleted with the membership it acted for. */
export function memberConnectionEnded(connection: MemberConnection, reason: MembershipEnd, by: string): LedgerEntryInput {
  return {
    actor: "human",
    domain: "system",
    action: "extension_disconnected",
    summary: "Disconnected the Chrome extension Vestiarion Invoice Capture",
    detail: { by, connectionId: connection.id, client: connection.clientId, reason },
  };
}
