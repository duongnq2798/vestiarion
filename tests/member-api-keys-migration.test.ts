import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, MIGRATIONS_DIR,
} from "./support/pglite";

/**
 * Migration 0069 (docs/superpowers/specs/2026-10-03-member-api-keys-design.md, R1–R4, R7): a workspace API key works
 * only while the person who created it is a member of the workspace. Whatever ends the membership revokes the keys
 * that person created there, in the same transaction, and `remove_member_revoking_keys` says which, for the ledger.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const HASH = "a".repeat(64);
const EARLIER = new Date("2026-10-01T00:00:00Z");

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

let counter = 0;
const person = (label: string) => createUser(db, `${label}-${++counter}@example.com`);

/** A workspace with these members, each `[user, role]`. */
async function workspace(members: Array<[string, string]>): Promise<string> {
  const orgId = await createOrg(db, `member-keys-${++counter}`);
  for (const [userId, role] of members) {
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, userId, role]);
  }
  return orgId;
}

/** A key created as the app creates one: through create_api_key, as the service role, by `by`. */
const createKey = (orgId: string, by: string, name = "ci") =>
  asServiceRole(db, async (tx) =>
    (await tx.query<{ id: string }>(
      "select id from public.create_api_key($1, $2, $3, $4, $5, $6)", [orgId, name, nextPrefix(), HASH, ["read"], by]
    )).rows[0].id);

/** A key revoked by hand before the test, at a fixed time. */
async function revokedEarlier(orgId: string, by: string): Promise<string> {
  const keyId = await createKey(orgId, by, "retired");
  await db.query("update public.api_keys set revoked_at = $2 where id = $1", [keyId, EARLIER]);
  return keyId;
}

const revokedAt = async (keyId: string) =>
  (await db.query<{ revoked_at: Date | null }>("select revoked_at from public.api_keys where id = $1", [keyId])).rows[0].revoked_at;

const isMember = async (orgId: string, userId: string) =>
  (await db.query("select 1 from public.memberships where org_id = $1 and user_id = $2", [orgId, userId])).rows.length === 1;

const removeRevoking = (orgId: string, actor: string, userId: string) =>
  asServiceRole(db, async (tx) =>
    (await tx.query<{ removed_role: string; revoked_key_ids: string[] }>(
      "select * from public.remove_member_revoking_keys($1, $2, $3)", [orgId, actor, userId]
    )).rows[0]);

describe("remove_member_revoking_keys (R1, R4)", () => {
  it("revokes the leaver's active keys in that workspace only, and returns them oldest first", async () => {
    const owner = await person("owner");
    const leaver = await person("leaver");
    const orgId = await workspace([[owner, "owner"], [leaver, "admin"]]);
    const elsewhere = await workspace([[leaver, "owner"]]);
    const earlier = await revokedEarlier(orgId, leaver);
    const first = await createKey(orgId, leaver, "deploy");
    const second = await createKey(orgId, leaver, "reporting");
    const ownersKey = await createKey(orgId, owner);
    const keyElsewhere = await createKey(elsewhere, leaver);

    const result = await removeRevoking(orgId, leaver, leaver);

    expect(result).toEqual({ removed_role: "admin", revoked_key_ids: [first, second] });
    expect(await revokedAt(first)).not.toBeNull();
    expect(await revokedAt(second)).not.toBeNull();
    expect(await revokedAt(earlier)).toEqual(EARLIER);
    expect(await revokedAt(ownersKey)).toBeNull();
    expect(await revokedAt(keyElsewhere)).toBeNull();
    expect(await isMember(orgId, leaver)).toBe(false);
  });

  it("returns the removed role and that member's keys when an owner removes an admin", async () => {
    const owner = await person("owner");
    const admin = await person("admin");
    const orgId = await workspace([[owner, "owner"], [admin, "admin"]]);
    const key = await createKey(orgId, admin);

    expect(await removeRevoking(orgId, owner, admin)).toEqual({ removed_role: "admin", revoked_key_ids: [key] });
    expect(await revokedAt(key)).not.toBeNull();
  });

  it("returns no ids for a member who created no key", async () => {
    const owner = await person("owner");
    const viewer = await person("viewer");
    const orgId = await workspace([[owner, "owner"], [viewer, "viewer"]]);
    const ownersKey = await createKey(orgId, owner);

    expect(await removeRevoking(orgId, owner, viewer)).toEqual({ removed_role: "viewer", revoked_key_ids: [] });
    expect(await revokedAt(ownersKey)).toBeNull();
  });
});

describe("a refused removal revokes nothing (R4, R7)", () => {
  it("keeps an admin's keys when a viewer tries to remove them", async () => {
    const owner = await person("owner");
    const admin = await person("admin");
    const viewer = await person("viewer");
    const orgId = await workspace([[owner, "owner"], [admin, "admin"], [viewer, "viewer"]]);
    const key = await createKey(orgId, admin);

    await expect(removeRevoking(orgId, viewer, admin)).rejects.toThrow(/role_not_assignable/);

    expect(await revokedAt(key)).toBeNull();
    expect(await isMember(orgId, admin)).toBe(true);
  });

  it("keeps an admin's keys when someone outside the workspace tries to remove them", async () => {
    const owner = await person("owner");
    const admin = await person("admin");
    const outsider = await person("outsider");
    const orgId = await workspace([[owner, "owner"], [admin, "admin"]]);
    const key = await createKey(orgId, admin);

    await expect(removeRevoking(orgId, outsider, admin)).rejects.toThrow(/not_a_member/);

    expect(await revokedAt(key)).toBeNull();
    expect(await isMember(orgId, admin)).toBe(true);
  });

  it("names a target who is not a member", async () => {
    const owner = await person("owner");
    const stranger = await person("stranger");
    const orgId = await workspace([[owner, "owner"]]);

    await expect(removeRevoking(orgId, owner, stranger)).rejects.toThrow(/member_not_found/);
  });

  it("keeps the last owner, and the last owner's keys", async () => {
    const owner = await person("owner");
    const viewer = await person("viewer");
    const orgId = await workspace([[owner, "owner"], [viewer, "viewer"]]);
    const key = await createKey(orgId, owner);

    await expect(removeRevoking(orgId, owner, owner)).rejects.toThrow(/last owner/);

    expect(await revokedAt(key)).toBeNull();
    expect(await isMember(orgId, owner)).toBe(true);
  });
});

describe("whatever else ends a membership revokes too (R1)", () => {
  it("revokes through a plain remove_member, as code deployed before 0069 calls it", async () => {
    const owner = await person("owner");
    const admin = await person("admin");
    const orgId = await workspace([[owner, "owner"], [admin, "admin"]]);
    const key = await createKey(orgId, admin);

    await asServiceRole(db, (tx) => tx.query("select public.remove_member($1, $2, $3)", [orgId, owner, admin]));

    expect(await revokedAt(key)).not.toBeNull();
  });

  it("revokes when the membership row is deleted directly", async () => {
    const owner = await person("owner");
    const admin = await person("admin");
    const orgId = await workspace([[owner, "owner"], [admin, "admin"]]);
    const key = await createKey(orgId, admin);
    const ownersKey = await createKey(orgId, owner);

    await db.query("delete from public.memberships where org_id = $1 and user_id = $2", [orgId, admin]);

    expect(await revokedAt(key)).not.toBeNull();
    expect(await revokedAt(ownersKey)).toBeNull();
  });

  it("lets a deleted workspace take its memberships and keys with it", async () => {
    const owner = await person("owner");
    const admin = await person("admin");
    const orgId = await workspace([[owner, "owner"], [admin, "admin"]]);
    await createKey(orgId, admin);
    await createKey(orgId, owner);

    await db.query("delete from public.orgs where id = $1", [orgId]);

    expect((await db.query("select 1 from public.api_keys where org_id = $1", [orgId])).rows).toEqual([]);
    expect((await db.query("select 1 from public.memberships where org_id = $1", [orgId])).rows).toEqual([]);
  });
});

describe("deleting an account (R2)", () => {
  it("revokes the account's keys in every workspace it leaves, and clears created_by", async () => {
    const owner = await person("owner");
    const leaving = await person("leaving");
    const first = await workspace([[owner, "owner"], [leaving, "admin"]]);
    const second = await workspace([[owner, "owner"], [leaving, "admin"]]);
    const one = await createKey(first, leaving);
    const two = await createKey(second, leaving);
    const earlier = await revokedEarlier(first, leaving);
    const ownersKey = await createKey(first, owner);

    await db.query("delete from auth.users where id = $1", [leaving]);

    const { rows } = await db.query<{ id: string; created_by: string | null; revoked: boolean }>(
      "select id, created_by, revoked_at is not null as revoked from public.api_keys where id = any($1::uuid[]) order by id",
      [[one, two]]
    );
    expect(rows).toEqual(
      [one, two].sort().map((id) => ({ id, created_by: null, revoked: true }))
    );
    expect(await revokedAt(earlier)).toEqual(EARLIER);
    expect(await revokedAt(ownersKey)).toBeNull();
  });

  it("revokes a key whose created_by is cleared, as deleting its creator's account clears it", async () => {
    const owner = await person("owner");
    const orgId = await workspace([[owner, "owner"]]);
    const key = await createKey(orgId, owner);

    await db.query("update public.api_keys set created_by = null where id = $1", [key]);

    expect(await revokedAt(key)).not.toBeNull();
  });

  it("revokes nothing on any other update of a key", async () => {
    const owner = await person("owner");
    const orgId = await workspace([[owner, "owner"]]);
    const key = await createKey(orgId, owner);

    await db.query("update public.api_keys set name = 'renamed', last_used_at = now() where id = $1", [key]);

    expect(await revokedAt(key)).toBeNull();
  });
});

describe("only a member creates a key (R3)", () => {
  it("refuses a key for someone who is a member of another workspace only, and stores nothing", async () => {
    const owner = await person("owner");
    const outsider = await person("outsider");
    const orgId = await workspace([[owner, "owner"]]);
    await workspace([[outsider, "owner"]]);

    await expect(createKey(orgId, outsider)).rejects.toThrow(/api_key_creator_not_a_member/);

    expect((await db.query("select 1 from public.api_keys where org_id = $1 and created_by = $2", [orgId, outsider])).rows).toEqual([]);
  });

  it("refuses a key for someone who has left the workspace", async () => {
    const owner = await person("owner");
    const former = await person("former");
    const orgId = await workspace([[owner, "owner"], [former, "admin"]]);
    await removeRevoking(orgId, former, former);

    await expect(createKey(orgId, former)).rejects.toThrow(/api_key_creator_not_a_member/);
  });

  it("accepts a key with no creator, which only the operator can insert", async () => {
    const orgId = await workspace([]);

    await expect(
      db.query("insert into public.api_keys (org_id, name, prefix, secret_hash) values ($1, 'operator', $2, $3)", [orgId, nextPrefix(), HASH])
    ).resolves.toBeTruthy();
  });
});

describe("who may call remove_member_revoking_keys", () => {
  it.each(["anon", "authenticated"] as const)("%s cannot execute it", async (role) => {
    await expect(asRole(db, role, (tx) =>
      tx.query("select * from public.remove_member_revoking_keys($1, $2, $3)", [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()])
    )).rejects.toThrow(/permission denied/);
  });

  it("the tenant role cannot execute it", async () => {
    const orgId = await workspace([]);

    await expect(asTenant(db, orgId, (tx) =>
      tx.query("select * from public.remove_member_revoking_keys($1, $2, $3)", [orgId, crypto.randomUUID(), crypto.randomUUID()])
    )).rejects.toThrow(/permission denied/);
  });

  it("is security definer with an empty search_path", async () => {
    const { rows } = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      "select prosecdef, proconfig from pg_proc where oid = 'public.remove_member_revoking_keys(uuid, uuid, uuid)'::regprocedure"
    );
    expect(rows).toEqual([{ prosecdef: true, proconfig: ['search_path=""'] }]);
  });
});

describe("replaying 0069", () => {
  it("runs again without error, keeping one of each trigger", async () => {
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0069_member_api_keys.sql"), "utf8"));

    const { rows } = await db.query<{ tgname: string }>(
      `select tgname from pg_trigger
        where not tgisinternal
          and tgname in ('memberships_revoke_api_keys', 'api_keys_revoke_without_creator', 'api_keys_creator_is_member')
        order by tgname`
    );
    expect(rows.map((row) => row.tgname)).toEqual([
      "api_keys_creator_is_member", "api_keys_revoke_without_creator", "memberships_revoke_api_keys",
    ]);
  });
});
