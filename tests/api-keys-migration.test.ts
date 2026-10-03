import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser,
} from "./support/pglite";

/**
 * Migration 0027 (API keys design §4, K1, K2, K7): a platform table of
 * workspace API keys, stored as a prefix and the SHA-256 of the secret, and
 * `create_api_key`, which holds each organization to 20 active keys under an
 * advisory lock. Only the service role reads or writes either.
 */

let db: PGlite;
let owner: string;
let orgId: string;

const HASH = "a".repeat(64);
let prefixCounter = 0;
/** A fresh valid prefix: eight characters of a-z2-7. */
function nextPrefix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let n = prefixCounter++;
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = alphabet[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  owner = await createUser(db, "owner@example.com");
  orgId = await createOrg(db, "keys-co");
}, 60_000);

afterAll(async () => {
  await db.close();
});

/** Inserts a key directly, as the superuser (the service role's stand-in). */
async function insertKey(values: { org?: string; name?: string; prefix?: string; hash?: string; scopes?: string[] | null } = {}) {
  const scopes = values.scopes === undefined ? ["read"] : values.scopes;
  return db.query<{ id: string }>(
    `insert into public.api_keys (org_id, name, prefix, secret_hash, scopes)
     values ($1, $2, $3, $4, coalesce($5::text[], '{read}')) returning id`,
    [values.org ?? orgId, values.name ?? "ci", values.prefix ?? nextPrefix(), values.hash ?? HASH, scopes]
  );
}

/** A key `owner` creates, as an owner of `org`: only a member of a workspace creates its keys (0069). */
const create = async (org: string, name: string, scopes: string[] = ["read"], prefix = nextPrefix()) => {
  await db.query(
    "insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner') on conflict (org_id, user_id) do nothing", [org, owner]);
  return asServiceRole(db, async (tx) =>
    (await tx.query<Record<string, unknown>>(
      "select * from public.create_api_key($1, $2, $3, $4, $5, $6)", [org, name, prefix, HASH, scopes, owner]
    )).rows[0]);
};

describe("the api_keys table", () => {
  it("accepts a well-formed key with the default scope", async () => {
    const { rows } = await insertKey({ scopes: null });
    const row = (await db.query<{ scopes: string[]; revoked_at: Date | null; last_used_at: Date | null }>(
      "select scopes, revoked_at, last_used_at from public.api_keys where id = $1", [rows[0].id])).rows[0];
    expect(row).toEqual({ scopes: ["read"], revoked_at: null, last_used_at: null });
  });

  it.each([
    ["too short", "abcdefg"],
    ["too long", "abcdefghi"],
    ["upper case", "ABCDEFGH"],
    ["outside base32", "abcdefg1"],
  ])("refuses a prefix that is %s", async (_label, prefix) => {
    await expect(insertKey({ prefix })).rejects.toThrow(/api_keys_prefix_check/);
  });

  it.each([
    ["too short", "a".repeat(63)],
    ["upper-case hex", "A".repeat(64)],
    ["not hex", "g".repeat(64)],
  ])("refuses a secret hash that is %s", async (_label, hash) => {
    await expect(insertKey({ hash })).rejects.toThrow(/api_keys_secret_hash_check/);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["61 characters", "x".repeat(61)],
  ])("refuses a name that is %s", async (_label, name) => {
    await expect(insertKey({ name })).rejects.toThrow(/api_keys_name_check/);
  });

  it("accepts a 60-character name", async () => {
    await expect(insertKey({ name: "x".repeat(60) })).resolves.toBeTruthy();
  });

  // Since 0066 (write API R1) a key may also write, but never without read.
  it.each([
    ["{write}", ["write"]],
    ["{read,admin}", ["read", "admin"]],
    ["{}", []],
  ])("refuses scopes %s", async (_label, scopes) => {
    await expect(insertKey({ scopes })).rejects.toThrow(/api_keys_scopes_check/);
  });

  it("accepts scopes {read}", async () => {
    await expect(insertKey({ scopes: ["read"] })).resolves.toBeTruthy();
  });

  it("accepts scopes {read,write} (0066)", async () => {
    await expect(insertKey({ scopes: ["read", "write"] })).resolves.toBeTruthy();
  });

  it("refuses a second key with the same prefix, even in another organization", async () => {
    const other = await createOrg(db, "prefix-other-co");
    const prefix = nextPrefix();
    await insertKey({ prefix });
    await expect(insertKey({ org: other, prefix })).rejects.toThrow(/api_keys_prefix_key|duplicate key/);
  });

  it("is indexed by org_id", async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'api_keys_org_idx'");
    expect(rows[0]?.indexdef).toMatch(/\(org_id\)/);
  });

  it("goes when its organization is deleted", async () => {
    const org = await createOrg(db, "cascade-co");
    await insertKey({ org });
    await db.query("delete from public.orgs where id = $1", [org]);
    const { rows } = await db.query("select 1 from public.api_keys where org_id = $1", [org]);
    expect(rows).toEqual([]);
  });

  // 0069 revokes it in the same update: tests/member-api-keys-migration.test.ts.
  it("keeps the key's row when its creator's account is deleted", async () => {
    const creator = await createUser(db, "creator@example.com");
    const org = await createOrg(db, "creator-co");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'admin')", [org, creator]);
    const row = await asServiceRole(db, async (tx) =>
      (await tx.query<{ id: string }>(
        "select * from public.create_api_key($1, $2, $3, $4, $5, $6)", [org, "ci", nextPrefix(), HASH, ["read"], creator]
      )).rows[0]);
    await db.query("delete from auth.users where id = $1", [creator]);
    const { rows } = await db.query<{ created_by: string | null }>("select created_by from public.api_keys where id = $1", [row.id]);
    expect(rows).toEqual([{ created_by: null }]);
  });
});

describe("create_api_key", () => {
  it("inserts a trimmed name and returns the row", async () => {
    const org = await createOrg(db, "create-co");
    const prefix = nextPrefix();
    const row = await create(org, "  deploy bot  ", ["read"], prefix);
    expect(row).toMatchObject({ org_id: org, name: "deploy bot", prefix, secret_hash: HASH, scopes: ["read"], created_by: owner });
    expect(row.id).toBeTruthy();
    expect(row.created_at).toBeTruthy();
    expect(row.revoked_at).toBeNull();
  });

  it("refuses scopes beyond read and write through the table check", async () => {
    const org = await createOrg(db, "scope-co");
    await expect(create(org, "ci", ["read", "admin"])).rejects.toThrow(/api_keys_scopes_check/);
    await expect(create(org, "ci", ["write"])).rejects.toThrow(/api_keys_scopes_check/);
  });

  it("creates a read-and-write key (0066)", async () => {
    const org = await createOrg(db, "write-co");
    expect(await create(org, "ci", ["read", "write"])).toMatchObject({ scopes: ["read", "write"] });
  });

  it("refuses the 21st active key, and a revoked key frees a slot", async () => {
    const org = await createOrg(db, "limit-co");
    for (let i = 0; i < 20; i++) await create(org, `key ${i}`);
    await expect(create(org, "one too many")).rejects.toThrow(
      /api_key_limit_reached: at most 20 active API keys per organization/);

    await db.query(
      "update public.api_keys set revoked_at = now() where id = (select id from public.api_keys where org_id = $1 limit 1)", [org]);
    await expect(create(org, "replacement")).resolves.toMatchObject({ name: "replacement" });
    await expect(create(org, "and no more")).rejects.toThrow(/api_key_limit_reached/);
  });

  it("counts each organization's keys separately", async () => {
    const full = await createOrg(db, "full-co");
    for (let i = 0; i < 20; i++) await create(full, `key ${i}`);
    const empty = await createOrg(db, "empty-co");
    await expect(create(empty, "first")).resolves.toMatchObject({ org_id: empty });
  });
});

describe("who may read the table or call the function", () => {
  it.each(["anon", "authenticated"] as const)("%s cannot select from api_keys", async (role) => {
    await expect(asRole(db, role, (tx) => tx.query("select * from public.api_keys"))).rejects.toThrow(/permission denied/);
  });

  it("the tenant role cannot select from api_keys", async () => {
    await expect(asTenant(db, orgId, (tx) => tx.query("select * from public.api_keys"))).rejects.toThrow(/permission denied/);
  });

  it.each(["anon", "authenticated"] as const)("%s cannot execute create_api_key", async (role) => {
    await expect(asRole(db, role, (tx) =>
      tx.query("select * from public.create_api_key($1, $2, $3, $4, $5, $6)", [orgId, "x", nextPrefix(), HASH, ["read"], owner])
    )).rejects.toThrow(/permission denied/);
  });

  it("the tenant role cannot execute create_api_key", async () => {
    await expect(asTenant(db, orgId, (tx) =>
      tx.query("select * from public.create_api_key($1, $2, $3, $4, $5, $6)", [orgId, "x", nextPrefix(), HASH, ["read"], owner])
    )).rejects.toThrow(/permission denied/);
  });

  it("the service role can read the table", async () => {
    await expect(asServiceRole(db, (tx) => tx.query("select id from public.api_keys"))).resolves.toBeTruthy();
  });
});

describe("replaying 0027", () => {
  it("replays every migration twice without error", async () => {
    const fresh = await createDatabase();
    try {
      await applyMigrations(fresh);
      await applyMigrations(fresh);
    } finally {
      await fresh.close();
    }
  }, 60_000);
});
