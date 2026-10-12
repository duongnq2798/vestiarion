import crypto from "node:crypto";
import { currentOrgId } from "../context";
import { platformDb, unwrap } from "../dal";
import { decryptSecret, encryptSecret, masterKeysFromEnv, type MasterKey, type SecretEnvelope } from "../secrets";
import type { ExternalOrganisation, ProviderId, ProviderTokens } from "./provider";
import type { Consent } from "./state";
import { type StoredTokens, type TokenStore } from "./tokens";

/**
 * The one module that reads or writes an accounting connection's tokens (docs/superpowers/specs/2026-10-12-xero-connector-design.md
 * X2, X5, X17). `accounting_tokens` is a platform table only the service role reaches (migration 0101), as
 * `slack_installs` is. Each token is an envelope under the master key bound to the workspace, its column and its row,
 * so a ciphertext copied into another row or column does not open. Every function but the sweeper's listing runs in
 * the workspace's own scope and names it; tokens leave here only for the provider.
 */

const ACCESS = "accounting_tokens.access_token_enc";
const REFRESH = "accounting_tokens.refresh_token_enc";
const columnOf = (base: string, id: string) => `${base}/${id}`;

interface TokenRow {
  id: string;
  org_id: string;
  provider: ProviderId;
  connection_id: string | null;
  authorized_by: string | null;
  access_token_enc: SecretEnvelope;
  refresh_token_enc: SecretEnvelope;
  access_expires_at: string;
  scopes: string[] | null;
  version: number | string;
  choices: unknown;
  choose_until: string | null;
}

const COLUMNS = "id, org_id, provider, connection_id, authorized_by, access_token_enc, refresh_token_enc, access_expires_at, scopes, version, choices, choose_until";

/** Tokens are touched only in their own workspace's scope. */
function requireScope(orgId: string): void {
  if (currentOrgId() !== orgId) throw new Error("An accounting connection's tokens are reached only in its own workspace's scope");
}

function sealed(orgId: string, id: string, tokens: ProviderTokens, keys: MasterKey[]) {
  return {
    access_token_enc: encryptSecret(tokens.accessToken, { orgId, column: columnOf(ACCESS, id) }, keys),
    refresh_token_enc: encryptSecret(tokens.refreshToken, { orgId, column: columnOf(REFRESH, id) }, keys),
    access_expires_at: new Date(tokens.expiresAt).toISOString(),
    scopes: tokens.scopes,
  };
}

function opened(row: TokenRow, keys: MasterKey[]): StoredTokens {
  return {
    id: row.id,
    version: Number(row.version),
    accessToken: decryptSecret(row.access_token_enc, { orgId: row.org_id, column: columnOf(ACCESS, row.id) }, keys),
    refreshToken: decryptSecret(row.refresh_token_enc, { orgId: row.org_id, column: columnOf(REFRESH, row.id) }, keys),
    expiresAt: Date.parse(row.access_expires_at),
    scopes: row.scopes ?? [],
  };
}

/**
 * Keeps a fresh grant: for a connection, or, with `choices`, as a pending one while the person who authorized it picks
 * an organisation, until `chooseUntil`. A connection's earlier tokens are replaced. Returns the row's id.
 */
export async function saveTokens(
  input: {
    orgId: string;
    provider: ProviderId;
    connectionId: string | null;
    authorizedBy: string;
    tokens: ProviderTokens;
    pending?: { choices: ExternalOrganisation[]; chooseUntil: string; consent: Consent };
  },
  keys: MasterKey[] = masterKeysFromEnv()
): Promise<string> {
  requireScope(input.orgId);
  if ((input.connectionId === null) !== (input.pending !== undefined)) throw new Error("A grant is either a connection's or pending a choice");
  if (input.connectionId) {
    unwrap(await platformDb().from("accounting_tokens").delete().eq("org_id", input.orgId).eq("connection_id", input.connectionId).select("id"));
  }
  const id = crypto.randomUUID();
  unwrap(
    await platformDb()
      .from("accounting_tokens")
      .insert({
        id,
        org_id: input.orgId,
        provider: input.provider,
        connection_id: input.connectionId,
        authorized_by: input.authorizedBy,
        ...sealed(input.orgId, id, input.tokens, keys),
        // The organisations offered, and the consent the person gave before going to the provider.
        choices: input.pending ? { organisations: input.pending.choices, consent: input.pending.consent } : null,
        choose_until: input.pending?.chooseUntil ?? null,
      })
      .select("id")
  );
  return id;
}

export interface PendingChoice {
  id: string;
  provider: ProviderId;
  choices: ExternalOrganisation[];
  consent: Consent | null;
  scopes: string[];
  chooseUntil: string;
}

function consentOf(value: unknown): Consent | null {
  if (typeof value !== "object" || value === null) return null;
  const { version, at } = value as Record<string, unknown>;
  return typeof version === "string" && typeof at === "string" ? { version, at } : null;
}

function choicesOf(value: unknown): ExternalOrganisation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((choice): ExternalOrganisation[] => {
    if (typeof choice !== "object" || choice === null) return [];
    const { externalOrgId, name, connectionId } = choice as Record<string, unknown>;
    if (typeof externalOrgId !== "string" || typeof name !== "string") return [];
    return [{ externalOrgId, name, connectionId: typeof connectionId === "string" ? connectionId : null }];
  });
}

/** A pending choice, only for the person who authorized it, in its workspace, before its deadline. */
export async function pendingChoice(orgId: string, tokenId: string, userId: string, nowMs: number = Date.now()): Promise<PendingChoice | null> {
  requireScope(orgId);
  const rows = unwrap(
    await platformDb()
      .from("accounting_tokens")
      .select("id, provider, choices, choose_until, authorized_by, scopes")
      .eq("id", tokenId)
      .eq("org_id", orgId)
      .is("connection_id", null)
      .limit(1)
  ) as Array<Pick<TokenRow, "id" | "provider" | "choices" | "choose_until" | "authorized_by" | "scopes">>;
  const row = rows[0];
  if (!row || row.authorized_by !== userId || !row.choose_until || Date.parse(row.choose_until) <= nowMs) return null;
  const held = typeof row.choices === "object" && row.choices !== null ? (row.choices as Record<string, unknown>) : {};
  return { id: row.id, provider: row.provider, choices: choicesOf(held.organisations), consent: consentOf(held.consent), scopes: row.scopes ?? [], chooseUntil: row.choose_until };
}

/** Gives a pending grant to the connection picked: once, before its deadline. False when it was used or ran out. */
export async function attachPending(orgId: string, tokenId: string, connectionId: string, nowMs: number = Date.now()): Promise<boolean> {
  requireScope(orgId);
  unwrap(await platformDb().from("accounting_tokens").delete().eq("org_id", orgId).eq("connection_id", connectionId).select("id"));
  const rows = unwrap(
    await platformDb()
      .from("accounting_tokens")
      .update({ connection_id: connectionId, choices: null, choose_until: null })
      .eq("id", tokenId)
      .eq("org_id", orgId)
      .is("connection_id", null)
      .gt("choose_until", new Date(nowMs).toISOString())
      .select("id")
  ) as Array<{ id: string }>;
  return rows.length === 1;
}

/** The refresh token of a row, opened, to revoke it; null when there is none. */
export async function refreshTokenOf(orgId: string, where: { connectionId: string } | { tokenId: string }, keys: MasterKey[] = masterKeysFromEnv()): Promise<string | null> {
  const row = await tokenRow(orgId, where);
  return row ? opened(row, keys).refreshToken : null;
}

async function tokenRow(orgId: string, where: { connectionId: string } | { tokenId: string }): Promise<TokenRow | null> {
  requireScope(orgId);
  const query = platformDb().from("accounting_tokens").select(COLUMNS).eq("org_id", orgId);
  const rows = unwrap(await ("connectionId" in where ? query.eq("connection_id", where.connectionId) : query.eq("id", where.tokenId)).limit(1)) as TokenRow[];
  return rows[0] ?? null;
}

/** Deletes a connection's tokens, or a pending grant: after its refresh token was revoked. */
export async function deleteTokens(orgId: string, where: { connectionId: string } | { tokenId: string }): Promise<void> {
  requireScope(orgId);
  const query = platformDb().from("accounting_tokens").delete().eq("org_id", orgId);
  unwrap(await ("connectionId" in where ? query.eq("connection_id", where.connectionId) : query.eq("id", where.tokenId)).select("id"));
}

/** The pending grants past their deadline, across every workspace, for the sweeper to revoke and delete. */
export async function expiredPendingGrants(nowMs: number, limit = 50): Promise<Array<{ orgId: string; tokenId: string; provider: ProviderId }>> {
  const rows = unwrap(
    await platformDb()
      .from("accounting_tokens")
      .select("id, org_id, provider")
      .is("connection_id", null)
      .lt("choose_until", new Date(nowMs).toISOString())
      .limit(limit)
  ) as Array<Pick<TokenRow, "id" | "org_id" | "provider">>;
  return rows.map((row) => ({ orgId: row.org_id, tokenId: row.id, provider: row.provider }));
}

/** The database's `TokenStore` for one connection's row: the lease and the compare-and-set of migration 0101. */
export function connectionTokenStore(orgId: string, connectionId: string, keys: MasterKey[] = masterKeysFromEnv()): TokenStore {
  let tokenId: string | null = null;
  const remember = (row: TokenRow | null) => {
    if (row) tokenId = row.id;
    return row ? opened(row, keys) : null;
  };
  return {
    async read() {
      return remember(await tokenRow(orgId, { connectionId }));
    },
    async lease(holder, seconds) {
      requireScope(orgId);
      if (!tokenId) return null;
      const rows = unwrap(
        await platformDb().rpc("accounting_token_lease", { p_org_id: orgId, p_token_id: tokenId, p_holder: holder, p_seconds: seconds })
      ) as TokenRow[];
      return remember(rows[0] ?? null);
    },
    async store(holder, version, tokens) {
      requireScope(orgId);
      if (!tokenId) return false;
      const seal = sealed(orgId, tokenId, tokens, keys);
      const result = await platformDb().rpc("accounting_token_store", {
        p_org_id: orgId,
        p_token_id: tokenId,
        p_holder: holder,
        p_version: version,
        p_access_enc: seal.access_token_enc,
        p_refresh_enc: seal.refresh_token_enc,
        p_access_expires_at: seal.access_expires_at,
        p_scopes: seal.scopes,
      });
      if (result.error) throw new Error(result.error.message);
      // The new version, or null when the lease or the version moved on.
      return result.data !== null && result.data !== undefined;
    },
    async release(holder) {
      requireScope(orgId);
      if (!tokenId) return;
      const result = await platformDb().rpc("accounting_token_release", { p_org_id: orgId, p_token_id: tokenId, p_holder: holder });
      if (result.error) throw new Error(result.error.message);
    },
  };
}
