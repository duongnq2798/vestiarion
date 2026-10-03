import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import {
  activeKeyNamesByCreator,
  API_KEY_SCOPES,
  ApiKeyError,
  apiKeyRevokedEntry,
  authenticateApiKey,
  createApiKey,
  generateApiKey,
  listApiKeys,
  parseApiKey,
  revokeApiKey,
  touchApiKeyUsed,
} from "@/lib/platform/api-keys";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/lib/platform/api-keys.ts` against a real supabase-js client whose
 * network is a recorder, the same shape as `tests/members.test.ts`: the
 * `api_keys` table and `create_api_key` from migration 0027 are answered as
 * PostgREST would, and the ledger append runs in the organization's scope.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-0000000000a9";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a7";
const OTHER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b8";
const KEY_ID = "7c3e9f1a-2b4d-4e6f-8a0b-0000000000ee";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
  vi.restoreAllMocks();
});

function orgRow() {
  return {
    id: ORG,
    slug: "northstar",
    name: "Northstar",
    mode: "live",
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
  };
}

const sha256Hex = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

/** A stored key, as `api_keys` holds it, for a token generated here. */
function storedKey(token: string, overrides: Record<string, unknown> = {}) {
  const parsed = parseApiKey(token)!;
  return {
    id: KEY_ID,
    org_id: ORG,
    name: "deploy bot",
    prefix: parsed.prefix,
    secret_hash: sha256Hex(parsed.secret),
    scopes: ["read"],
    created_by: ACTOR,
    created_at: "2026-09-29T00:00:00Z",
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  };
}

/** PostgREST as `api-keys.ts` meets it: `api_keys`, `create_api_key` and `append_ledger_entry`. */
function keysFake(options: {
  createApiKey?: (request: RecordedRequest) => FakeReply | undefined;
  apiKeys?: (request: RecordedRequest) => FakeReply;
  ledgerFails?: boolean;
} = {}) {
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/rpc/create_api_key") {
      const failure = options.createApiKey?.(request);
      if (failure) return failure;
      const body = request.body as Record<string, unknown>;
      return {
        body: {
          id: KEY_ID, org_id: body.p_org_id, name: body.p_name, prefix: body.p_prefix, secret_hash: body.p_secret_hash,
          scopes: body.p_scopes, created_by: body.p_by, created_at: "2026-09-29T00:00:00Z", last_used_at: null, revoked_at: null,
        },
      };
    }
    if (request.path === "/rest/v1/api_keys") return options.apiKeys ? options.apiKeys(request) : { body: [] };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      if (options.ledgerFails) return { status: 500, body: { message: "ledger unavailable" } };
      return {
        body: {
          seq: 1, id: "e1", ts: "2026-09-29T00:00:00Z", actor: "human", domain: "system", action: "x",
          summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
        },
      };
    }
    return { body: [] };
  });
  return { fake, run: <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn) };
}

function rpcBodies(requests: RecordedRequest[], name: string) {
  return requests.filter((request) => request.path === `/rest/v1/rpc/${name}`).map((request) => request.body as Record<string, unknown>);
}

/** Everything that left the process: every path, query string and body. */
function everythingSent(requests: RecordedRequest[]): string {
  return JSON.stringify(requests.map((request) => ({ path: request.path, params: request.params.toString(), body: request.body })));
}

describe("generateApiKey and parseApiKey", () => {
  it("builds vxk_<8 base32 characters>_<43 base64url characters>, and hashes only the secret", () => {
    const { token, prefix, secretHash } = generateApiKey();
    expect(token).toMatch(/^vxk_[a-z2-7]{8}_[A-Za-z0-9_-]{43}$/);
    expect(prefix).toMatch(/^[a-z2-7]{8}$/);
    const secret = token.slice(`vxk_${prefix}_`.length);
    expect(token.startsWith(`vxk_${prefix}_`)).toBe(true);
    expect(secretHash).toBe(sha256Hex(secret));
    expect(secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives the prefix and the secret from the random source", () => {
    const random = vi.fn((n: number) => Buffer.alloc(n, 0xff));
    const { token, prefix } = generateApiKey(random);
    expect(prefix).toBe("77777777");
    expect(token).toBe(`vxk_77777777_${Buffer.alloc(32, 0xff).toString("base64url")}`);
    expect(random).toHaveBeenCalledWith(32);
  });

  it("matches the RFC 4648 base32 test vector for a 5-byte prefix source", () => {
    // "77777777" from all-0xff bytes cannot catch a bit-order bug: 0xff is
    // invariant under any bit order. RFC 4648's own test vector pins it.
    const random = vi.fn((n: number) => (n === 5 ? Buffer.from("fooba") : Buffer.alloc(n)));
    const { prefix } = generateApiKey(random);
    expect(prefix).toBe("mzxw6ytb");
    expect(random).toHaveBeenCalledWith(5);
  });

  it("gives a different key each time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateApiKey().token));
    expect(tokens.size).toBe(50);
  });

  it("parses what it generates", () => {
    const { token, prefix, secretHash } = generateApiKey();
    const parsed = parseApiKey(token);
    expect(parsed).toEqual({ prefix, secret: token.slice(`vxk_${prefix}_`.length) });
    expect(sha256Hex(parsed!.secret)).toBe(secretHash);
  });

  it.each([
    ["an empty string", ""],
    ["another scheme", "sk_abcdefgh_" + "a".repeat(43)],
    ["a short prefix", "vxk_abcdefg_" + "a".repeat(43)],
    ["an upper-case prefix", "vxk_ABCDEFGH_" + "a".repeat(43)],
    ["a prefix outside base32", "vxk_abcdefg1_" + "a".repeat(43)],
    ["a short secret", "vxk_abcdefgh_" + "a".repeat(42)],
    ["a long secret", "vxk_abcdefgh_" + "a".repeat(44)],
    ["padding in the secret", "vxk_abcdefgh_" + "a".repeat(42) + "="],
    ["trailing whitespace", "vxk_abcdefgh_" + "a".repeat(43) + " "],
  ])("refuses %s", (_label, token) => {
    expect(parseApiKey(token)).toBeNull();
  });

  it("offers only the read scope", () => {
    expect(API_KEY_SCOPES).toEqual(["read"]);
  });
});

describe("createApiKey", () => {
  it("sends only the prefix and the hash, returns the token once, and records ids only", async () => {
    const { fake, run } = keysFake();

    const { key, token } = await run(() =>
      withOrg(ORG, () => createApiKey({ orgId: ORG, actorId: ACTOR, name: "  deploy bot  " })));

    const parsed = parseApiKey(token)!;
    expect(parsed).not.toBeNull();
    const [call] = rpcBodies(fake.requests, "create_api_key");
    expect(call).toEqual({
      p_org_id: ORG, p_name: "deploy bot", p_prefix: parsed.prefix, p_secret_hash: sha256Hex(parsed.secret),
      p_scopes: ["read"], p_by: ACTOR,
    });

    const sent = everythingSent(fake.requests);
    expect(sent).not.toContain(token);
    expect(sent).not.toContain(parsed.secret);

    expect(key).toEqual({
      id: KEY_ID, name: "deploy bot", prefix: parsed.prefix, scopes: ["read"],
      createdAt: "2026-09-29T00:00:00Z", lastUsedAt: null, revokedAt: null,
    });
    expect(JSON.stringify(key)).not.toContain(sha256Hex(parsed.secret));

    const appends = rpcBodies(fake.requests, "append_ledger_entry");
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({ p_org_id: ORG, p_action: "api_key_created", p_domain: "system", p_actor: "human" });
    expect(appends[0].p_detail).toEqual({ by: ACTOR, keyId: KEY_ID, scopes: ["read"] });
    const appendJson = JSON.stringify(appends);
    for (const leaked of [token, parsed.secret, parsed.prefix, sha256Hex(parsed.secret), "deploy bot"]) {
      expect(appendJson).not.toContain(leaked);
    }
  });

  it("asks the create RPC for the list columns only, never the hash", async () => {
    const { fake, run } = keysFake();

    await run(() => withOrg(ORG, () => createApiKey({ orgId: ORG, actorId: ACTOR, name: "ci" })));

    const [call] = fake.requests.filter((request) => request.path === "/rest/v1/rpc/create_api_key");
    expect(call.params.get("select")).toBe("id,name,prefix,scopes,created_at,last_used_at,revoked_at");
    expect(call.params.get("select")).not.toContain("secret_hash");
  });

  it("regenerates the key once when the prefix collides, and stores the regenerated one", async () => {
    let calls = 0;
    const { fake, run } = keysFake({
      createApiKey: () => {
        calls += 1;
        if (calls > 1) return undefined;
        return {
          status: 409,
          body: {
            code: "23505",
            message: 'duplicate key value violates unique constraint "api_keys_prefix_key"',
            details: "Key (prefix)=(abcdefgh) already exists.",
            hint: null,
          },
        };
      },
    });

    const { key, token } = await run(() =>
      withOrg(ORG, () => createApiKey({ orgId: ORG, actorId: ACTOR, name: "ci" })));

    expect(calls).toBe(2);
    const attempts = rpcBodies(fake.requests, "create_api_key");
    expect(attempts).toHaveLength(2);
    expect(attempts[0].p_prefix).not.toBe(attempts[1].p_prefix);
    const parsed = parseApiKey(token)!;
    expect(parsed.prefix).toBe(attempts[1].p_prefix);
    expect(key.prefix).toBe(attempts[1].p_prefix);
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(1);
  });

  it("does not retry a second prefix collision", async () => {
    const { run } = keysFake({
      createApiKey: () => ({
        status: 409,
        body: {
          code: "23505",
          message: 'duplicate key value violates unique constraint "api_keys_prefix_key"',
          details: "Key (prefix)=(abcdefgh) already exists.",
          hint: null,
        },
      }),
    });

    const attempt = run(() => withOrg(ORG, () => createApiKey({ orgId: ORG, actorId: ACTOR, name: "ci" })));
    await expect(attempt).rejects.toThrow(/api_keys_prefix_key/);
    await expect(attempt).rejects.not.toBeInstanceOf(ApiKeyError);
  });

  it("enters the organization's scope for the ledger entry when called outside it", async () => {
    const { fake, run } = keysFake();

    await run(() => createApiKey({ orgId: ORG, actorId: ACTOR, name: "ci" }));

    const appends = rpcBodies(fake.requests, "append_ledger_entry");
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({ p_org_id: ORG, p_action: "api_key_created" });
  });

  it("maps api_key_limit_reached to its own error, and records nothing", async () => {
    const { fake, run } = keysFake({
      createApiKey: () => ({
        status: 400,
        body: { code: "P0001", message: "api_key_limit_reached: at most 20 active API keys per organization", details: null, hint: null },
      }),
    });

    const attempt = run(() => withOrg(ORG, () => createApiKey({ orgId: ORG, actorId: ACTOR, name: "one too many" })));
    await expect(attempt).rejects.toBeInstanceOf(ApiKeyError);
    await expect(attempt).rejects.toMatchObject({
      code: "api_key_limit_reached",
      message: "This workspace already has 20 API keys. Revoke one first.",
    });
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  it("passes any other database error through as a plain error", async () => {
    const { run } = keysFake({
      createApiKey: () => ({ status: 500, body: { code: "XX000", message: "connection lost", details: null, hint: null } }),
    });
    const attempt = run(() => withOrg(ORG, () => createApiKey({ orgId: ORG, actorId: ACTOR, name: "ci" })));
    await expect(attempt).rejects.toThrow("connection lost");
    await expect(attempt).rejects.not.toBeInstanceOf(ApiKeyError);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["61 characters", "x".repeat(61)],
  ])("refuses a name that is %s before calling the database", async (_label, name) => {
    const { fake, run } = keysFake();
    const attempt = run(() => withOrg(ORG, () => createApiKey({ orgId: ORG, actorId: ACTOR, name })));
    await expect(attempt).rejects.toMatchObject({ code: "invalid_name" });
    await expect(attempt).rejects.toBeInstanceOf(ApiKeyError);
    expect(rpcBodies(fake.requests, "create_api_key")).toHaveLength(0);
  });

  it("accepts a 60-character name, measured after trimming", async () => {
    const { fake, run } = keysFake();
    await run(() => withOrg(ORG, () => createApiKey({ orgId: ORG, actorId: ACTOR, name: ` ${"x".repeat(60)} ` })));
    expect(rpcBodies(fake.requests, "create_api_key")[0].p_name).toBe("x".repeat(60));
  });

  it("still returns the key when the ledger append fails, logging no secret", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = keysFake({ ledgerFails: true });

    const { token } = await run(() => withOrg(ORG, () => createApiKey({ orgId: ORG, actorId: ACTOR, name: "ci" })));

    expect(parseApiKey(token)).not.toBeNull();
    expect(error).toHaveBeenCalledWith("ledger entry not recorded", "api_key_created", ORG);
    expect(JSON.stringify(error.mock.calls)).not.toContain(parseApiKey(token)!.secret);
  });
});

describe("listApiKeys", () => {
  it("asks for the organization's keys without the hash, and maps them", async () => {
    const { fake, run } = keysFake({
      apiKeys: () => ({
        body: [{
          id: KEY_ID, name: "ci", prefix: "abcdefgh", scopes: ["read"], created_at: "2026-09-29T00:00:00Z",
          last_used_at: "2026-09-29T01:00:00Z", revoked_at: null,
        }],
      }),
    });

    const rows = await run(() => listApiKeys(ORG));

    expect(rows).toEqual([{
      id: KEY_ID, name: "ci", prefix: "abcdefgh", scopes: ["read"], createdAt: "2026-09-29T00:00:00Z",
      lastUsedAt: "2026-09-29T01:00:00Z", revokedAt: null,
    }]);
    const listing = fake.requests.find((request) => request.path === "/rest/v1/api_keys");
    expect(listing?.method).toBe("GET");
    expect(listing?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(listing?.params.get("select")).not.toContain("secret_hash");
  });
});

describe("revokeApiKey", () => {
  it("revokes only an active key of this organization, and records ids only", async () => {
    const { fake, run } = keysFake({ apiKeys: () => ({ body: [{ id: KEY_ID }] }) });

    await run(() => withOrg(ORG, () => revokeApiKey({ orgId: ORG, actorId: ACTOR, keyId: KEY_ID })));

    const update = fake.requests.find((request) => request.path === "/rest/v1/api_keys");
    expect(update?.method).toBe("PATCH");
    expect(update?.params.get("id")).toBe(`eq.${KEY_ID}`);
    expect(update?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(update?.params.get("revoked_at")).toBe("is.null");
    expect(update?.params.get("select")).toBe("id");
    expect(Object.keys(update?.body as object)).toEqual(["revoked_at"]);

    const appends = rpcBodies(fake.requests, "append_ledger_entry");
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({ p_org_id: ORG, p_action: "api_key_revoked", p_summary: "An API key was revoked" });
    expect(appends[0].p_detail).toEqual({ by: ACTOR, keyId: KEY_ID, reason: "person" });
  });

  it("raises not_found when no row changes, and records nothing", async () => {
    const { fake, run } = keysFake({ apiKeys: () => ({ body: [] }) });

    const attempt = run(() => withOrg(ORG, () => revokeApiKey({ orgId: ORG, actorId: ACTOR, keyId: KEY_ID })));
    await expect(attempt).rejects.toBeInstanceOf(ApiKeyError);
    await expect(attempt).rejects.toMatchObject({ code: "not_found" });
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  it("raises not_found for an id that is not a uuid, without asking the database", async () => {
    const { fake, run } = keysFake();
    await expect(run(() => withOrg(ORG, () => revokeApiKey({ orgId: ORG, actorId: ACTOR, keyId: "nope" }))))
      .rejects.toMatchObject({ code: "not_found" });
    expect(fake.requests.filter((request) => request.path === "/rest/v1/api_keys")).toHaveLength(0);
  });
});

describe("apiKeyRevokedEntry", () => {
  it.each([
    ["person", "An API key was revoked"],
    ["member_left", "An API key was revoked when the member who created it left"],
    ["account_deleted", "An API key was revoked when the member who created it deleted their account"],
  ] as const)("says why for %s, by id only", (reason, summary) => {
    expect(apiKeyRevokedEntry({ reason, by: ACTOR, keyId: KEY_ID })).toEqual({
      actor: "human",
      domain: "system",
      action: "api_key_revoked",
      summary,
      detail: { by: ACTOR, keyId: KEY_ID, reason },
    });
  });

  it("names the member removed, as member_removed does, and the person who removed them as by", () => {
    expect(apiKeyRevokedEntry({ reason: "member_removed", by: ACTOR, keyId: KEY_ID, member: OTHER })).toEqual({
      actor: "human",
      domain: "system",
      action: "api_key_revoked",
      summary: "An API key was revoked when the member who created it was removed",
      detail: { by: ACTOR, keyId: KEY_ID, reason: "member_removed", member: OTHER },
    });
  });
});

describe("activeKeyNamesByCreator", () => {
  it("asks for the organization's active keys, oldest first, and groups their names by who created them", async () => {
    const { fake, run } = keysFake({
      apiKeys: () => ({
        body: [
          { name: "deploy", created_by: ACTOR },
          { name: "operator import", created_by: null },
          { name: "reporting", created_by: OTHER },
          { name: "backup", created_by: ACTOR },
        ],
      }),
    });

    const names = await run(() => activeKeyNamesByCreator(ORG));

    expect(names).toEqual({ [ACTOR]: ["deploy", "backup"], [OTHER]: ["reporting"] });
    const listing = fake.requests.find((request) => request.path === "/rest/v1/api_keys");
    expect(listing?.method).toBe("GET");
    expect(listing?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(listing?.params.get("revoked_at")).toBe("is.null");
    expect(listing?.params.get("select")).toBe("name,created_by");
    expect(listing?.params.get("order")).toBe("created_at.asc");
  });

  it("is empty for a workspace with no active key", async () => {
    const { run } = keysFake({ apiKeys: () => ({ body: [] }) });
    await expect(run(() => activeKeyNamesByCreator(ORG))).resolves.toEqual({});
  });
});

describe("authenticateApiKey", () => {
  const live = generateApiKey();

  const authFake = (row: Record<string, unknown> | null) =>
    keysFake({ apiKeys: () => ({ body: row ? [row] : [] }) });

  it("returns the organization, the key and its scopes for a live key", async () => {
    const { fake, run } = authFake(storedKey(live.token));

    const result = await run(() => authenticateApiKey(`Bearer ${live.token}`));

    expect(result).toEqual({ keyId: KEY_ID, orgId: ORG, scopes: ["read"] });
    const lookup = fake.requests.find((request) => request.path === "/rest/v1/api_keys");
    expect(lookup?.method).toBe("GET");
    expect(lookup?.params.get("prefix")).toBe(`eq.${live.prefix}`);
    expect(lookup?.params.get("select")).toBe("id,org_id,secret_hash,scopes,revoked_at");
    // Only the prefix leaves the process; the secret never does.
    const sent = everythingSent(fake.requests);
    expect(sent).not.toContain(live.token);
    expect(sent).not.toContain(parseApiKey(live.token)!.secret);
  });

  it("returns null for a revoked key", async () => {
    const { run } = authFake(storedKey(live.token, { revoked_at: "2026-09-29T02:00:00Z" }));
    await expect(run(() => authenticateApiKey(`Bearer ${live.token}`))).resolves.toBeNull();
  });

  it("returns null for an unknown prefix", async () => {
    const { run } = authFake(null);
    await expect(run(() => authenticateApiKey(`Bearer ${live.token}`))).resolves.toBeNull();
  });

  it("returns null for a wrong secret under a known prefix", async () => {
    const other = generateApiKey();
    const forged = `vxk_${live.prefix}_${parseApiKey(other.token)!.secret}`;
    const { run } = authFake(storedKey(live.token));
    await expect(run(() => authenticateApiKey(`Bearer ${forged}`))).resolves.toBeNull();
  });

  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["a token without Bearer", live.token],
    ["another scheme", `Basic ${live.token}`],
    ["a malformed token", "Bearer vxk_short_secret"],
    ["the platform token shape", "Bearer some-long-platform-secret-value"],
  ])("returns null for %s, without asking the database", async (_label, header) => {
    const { fake, run } = authFake(storedKey(live.token));
    await expect(run(() => authenticateApiKey(header))).resolves.toBeNull();
    expect(fake.requests).toHaveLength(0);
  });

  it("compares with timingSafeEqual exactly once, whether or not the prefix exists", async () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual");

    const known = authFake(storedKey(live.token));
    await known.run(() => authenticateApiKey(`Bearer ${live.token}`));
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();
    const unknown = authFake(null);
    await unknown.run(() => authenticateApiKey(`Bearer ${live.token}`));
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();
    const wrong = authFake(storedKey(generateApiKey().token, { prefix: live.prefix }));
    await wrong.run(() => authenticateApiKey(`Bearer ${live.token}`));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("never logs the token", async () => {
    const logs = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
    ];
    const secret = parseApiKey(live.token)!.secret;

    for (const row of [storedKey(live.token), null, storedKey(live.token, { revoked_at: "2026-09-29T02:00:00Z" })]) {
      const { run } = authFake(row);
      await run(() => authenticateApiKey(`Bearer ${live.token}`));
    }
    const failing = keysFake({ apiKeys: () => ({ status: 500, body: { message: "db down" } }) });
    await failing.run(() => authenticateApiKey(`Bearer ${live.token}`)).catch(() => {});

    const logged = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(secret);
  });

  it("throws, without the token, when the lookup itself fails", async () => {
    const { run } = keysFake({ apiKeys: () => ({ status: 500, body: { message: "db down" } }) });
    const attempt = run(() => authenticateApiKey(`Bearer ${live.token}`));
    await expect(attempt).rejects.toThrow("db down");
    await attempt.catch((error: Error) => expect(error.message).not.toContain(parseApiKey(live.token)!.secret));
  });
});

describe("touchApiKeyUsed", () => {
  it("updates last_used_at only when it is unset or more than a minute old", async () => {
    const { fake, run } = keysFake();
    const now = new Date("2026-09-29T12:00:00.000Z");

    await run(() => touchApiKeyUsed(KEY_ID, now));

    const update = fake.requests.find((request) => request.path === "/rest/v1/api_keys");
    expect(update?.method).toBe("PATCH");
    expect(update?.body).toEqual({ last_used_at: "2026-09-29T12:00:00.000Z" });
    expect(update?.params.get("id")).toBe(`eq.${KEY_ID}`);
    expect(update?.params.get("or")).toBe("(last_used_at.is.null,last_used_at.lt.2026-09-29T11:59:00.000Z)");
  });

  it("never throws, and logs the key id only, when the update fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { run } = keysFake({ apiKeys: () => ({ status: 500, body: { message: "db down" } }) });

    await expect(run(() => touchApiKeyUsed(KEY_ID))).resolves.toBeUndefined();
    expect(warn.mock.calls).toEqual([["API key last use not recorded", KEY_ID]]);
  });

  it("never throws when the request itself fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { run } = keysFake({ apiKeys: () => { throw new Error("network down"); } });

    await expect(run(() => touchApiKeyUsed(KEY_ID))).resolves.toBeUndefined();
    expect(warn.mock.calls).toEqual([["API key last use not recorded", KEY_ID]]);
  });
});
