import crypto from "node:crypto";
import { bearerToken } from "../agent-security";
import { currentOrgId, NoOrgScopeError } from "../context";
import { platformDb, unwrap } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";

/**
 * Workspace API keys (docs/superpowers/specs/2026-09-29-api-keys-design.md,
 * K1–K8). A key is `vxk_<prefix>_<secret>`: the prefix is eight base32
 * characters that identify the key and are shown in lists; the secret is 32
 * random bytes, base64url. Only the prefix and `sha256(secret)` as hex are
 * stored (migration 0027), so the full key exists once, in the response that
 * creates it. A fast hash is right here: the secret carries 256 bits of
 * entropy, so there is nothing to brute-force.
 *
 * The token and the secret never leave this module in a request, a log line or
 * a ledger entry. The ledger records ids only (K8), best effort, after the
 * change has committed (see `appendLedgerEntryBestEffort`).
 */

export const API_KEY_SCOPES = ["read"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AuthenticatedKey {
  keyId: string;
  orgId: string;
  scopes: ApiKeyScope[];
}

export type ApiKeyErrorCode = "api_key_limit_reached" | "invalid_name" | "not_found";

const MESSAGES: Record<ApiKeyErrorCode, string> = {
  api_key_limit_reached: "This workspace already has 20 API keys. Revoke one first.",
  invalid_name: "A key's name must be 1 to 60 characters.",
  not_found: "No active API key with that id in this workspace.",
};

export class ApiKeyError extends Error {
  constructor(readonly code: ApiKeyErrorCode) {
    super(MESSAGES[code]);
    this.name = "ApiKeyError";
  }
}

const NAME_MAX = 60;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const TOKEN = /^vxk_([a-z2-7]{8})_([A-Za-z0-9_-]{43})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_HEX = /^[0-9a-f]{64}$/;
/** Compared against when no key has the presented prefix, so that path does the same one comparison. */
const DUMMY_HASH = Buffer.alloc(32);
/** K5: `last_used_at` is refreshed at most once a minute. */
const TOUCH_INTERVAL_MS = 60_000;

const LIST_COLUMNS = "id, name, prefix, scopes, created_at, last_used_at, revoked_at";

interface StoredKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function sha256(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === "string" && (API_KEY_SCOPES as readonly string[]).includes(value);
}

function toApiKeyRow(row: StoredKey): ApiKeyRow {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes.filter(isApiKeyScope),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/** Five random bytes are exactly eight base32 characters. */
function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export function generateApiKey(random: (n: number) => Buffer = crypto.randomBytes): {
  token: string;
  prefix: string;
  secretHash: string;
} {
  const prefix = base32(random(5));
  const secret = random(32).toString("base64url");
  return { token: `vxk_${prefix}_${secret}`, prefix, secretHash: sha256(secret).toString("hex") };
}

export function parseApiKey(token: string): { prefix: string; secret: string } | null {
  const match = TOKEN.exec(token);
  return match ? { prefix: match[1], secret: match[2] } : null;
}

/**
 * The ledger entry goes into the organization's own scope. A server action
 * already runs inside it (`inOrg`); any other caller has the append alone
 * enter it, as that person.
 */
function ledgerScope(orgId: string, actorId: string): { enterScope?: { userId: string } } {
  let scoped: string | null;
  try {
    scoped = currentOrgId();
  } catch (error) {
    if (!(error instanceof NoOrgScopeError)) throw error;
    scoped = null;
  }
  return scoped === orgId ? {} : { enterScope: { userId: actorId } };
}

export async function createApiKey(input: { orgId: string; actorId: string; name: string }): Promise<{ key: ApiKeyRow; token: string }> {
  const name = input.name.trim();
  // Code points, as Postgres's char_length counts them.
  const length = [...name].length;
  if (length < 1 || length > NAME_MAX) throw new ApiKeyError("invalid_name");

  const { token, prefix, secretHash } = generateApiKey();
  const scopes: ApiKeyScope[] = ["read"];
  const result = await platformDb()
    .rpc("create_api_key", {
      p_org_id: input.orgId,
      p_name: name,
      p_prefix: prefix,
      p_secret_hash: secretHash,
      p_scopes: scopes,
      p_by: input.actorId,
    })
    .single<StoredKey>();
  if (result.error) {
    if (/^api_key_limit_reached:/.test(result.error.message)) throw new ApiKeyError("api_key_limit_reached");
    throw new Error(result.error.message);
  }
  const key = toApiKeyRow(result.data as StoredKey);

  await appendLedgerEntryBestEffort(
    input.orgId,
    {
      actor: "human",
      domain: "system",
      action: "api_key_created",
      summary: "An API key was created",
      detail: { by: input.actorId, keyId: key.id, scopes: key.scopes },
    },
    ledgerScope(input.orgId, input.actorId)
  );

  return { key, token };
}

/** Every key of the organization, revoked ones included, newest first — never the hash. */
export async function listApiKeys(orgId: string): Promise<ApiKeyRow[]> {
  const rows = unwrap(
    await platformDb()
      .from("api_keys")
      .select(LIST_COLUMNS)
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
  ) as unknown as StoredKey[];
  return rows.map(toApiKeyRow);
}

/** Revoking ends a key (K4). A revoked key reads, from then on, exactly like an unknown one. */
export async function revokeApiKey(input: { orgId: string; actorId: string; keyId: string }): Promise<void> {
  if (!UUID.test(input.keyId)) throw new ApiKeyError("not_found");
  const rows = unwrap(
    await platformDb()
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", input.keyId)
      .eq("org_id", input.orgId)
      .is("revoked_at", null)
      .select("id")
  ) as Array<{ id: string }>;
  if (rows.length === 0) throw new ApiKeyError("not_found");

  await appendLedgerEntryBestEffort(
    input.orgId,
    {
      actor: "human",
      domain: "system",
      action: "api_key_revoked",
      summary: "An API key was revoked",
      detail: { by: input.actorId, keyId: input.keyId },
    },
    ledgerScope(input.orgId, input.actorId)
  );
}

/**
 * The key a request presents, or `null` for no header, a malformed, unknown or
 * revoked key, or a wrong secret — with no difference a caller can see.
 *
 * Exactly one `timingSafeEqual` runs on every path that reaches the database:
 * when no key has the prefix, the presented hash is compared against a fixed
 * dummy, so an unknown prefix takes the same work as a known one. The lookup
 * sends only the prefix; the secret is hashed here and never leaves.
 */
export async function authenticateApiKey(authorization: string | null): Promise<AuthenticatedKey | null> {
  const token = bearerToken(authorization);
  if (!token) return null;
  const parsed = parseApiKey(token);
  if (!parsed) return null;

  const result = await platformDb()
    .from("api_keys")
    .select("id, org_id, secret_hash, scopes, revoked_at")
    .eq("prefix", parsed.prefix)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as { id: string; org_id: string; secret_hash: string; scopes: string[]; revoked_at: string | null } | null;

  const stored = row && HASH_HEX.test(row.secret_hash) ? Buffer.from(row.secret_hash, "hex") : DUMMY_HASH;
  const matches = crypto.timingSafeEqual(sha256(parsed.secret), stored);
  if (!row || stored === DUMMY_HASH || !matches || row.revoked_at !== null) return null;

  return { keyId: row.id, orgId: row.org_id, scopes: row.scopes.filter(isApiKeyScope) };
}

/**
 * Records that a key was used, at most once a minute (K5): the update only
 * matches while `last_used_at` is unset or older than that. Best effort — it
 * never throws, so a request is served whether or not this lands, and a
 * failure is logged by key id only.
 */
export async function touchApiKeyUsed(keyId: string, now: Date = new Date()): Promise<void> {
  try {
    const cutoff = new Date(now.getTime() - TOUCH_INTERVAL_MS).toISOString();
    const result = await platformDb()
      .from("api_keys")
      .update({ last_used_at: now.toISOString() })
      .eq("id", keyId)
      .or(`last_used_at.is.null,last_used_at.lt.${cutoff}`);
    if (result.error) throw new Error(result.error.message);
  } catch {
    console.warn("API key last use not recorded", keyId);
  }
}
