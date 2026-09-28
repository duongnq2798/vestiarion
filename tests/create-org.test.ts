import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase, createUser } from "./support/pglite";

/**
 * Migration 0020: create_org is the only way an organization is born outside
 * the operator's scripts (spec §6, §10 step 5a). It enforces a per-person
 * limit of 3 workspaces and makes the caller its owner; a trigger then keeps
 * every organization's last owner from being removed or demoted.
 */

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  mode: string;
  created_by: string;
  ledger_signing_key_enc: unknown;
}

let db: PGlite;
let alice: string;
let bob: string;
let carol: string;

async function createOrgAs(
  userId: string,
  name: string,
  slug: string,
  keyEnc: Record<string, unknown> = { k: "x" }
): Promise<OrgRow> {
  const orgId = crypto.randomUUID();
  const result = await db.query<OrgRow>(
    "select * from public.create_org($1, $2, $3, $4, $5::jsonb)",
    [orgId, userId, name, slug, JSON.stringify(keyEnc)]
  );
  return result.rows[0];
}

async function ownerRole(orgId: string, userId: string): Promise<string | null> {
  const result = await db.query<{ role: string }>(
    "select role from public.memberships where org_id = $1 and user_id = $2",
    [orgId, userId]
  );
  return result.rows[0]?.role ?? null;
}

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  alice = await createUser(db, "alice@example.com");
  bob = await createUser(db, "bob@example.com");
  carol = await createUser(db, "carol@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("create_org", () => {
  it("creates the organization in sandbox mode and makes the caller its owner", async () => {
    const row = await createOrgAs(alice, "Alice Co", "alice-co", { k: "x" });
    expect(row).toMatchObject({ mode: "sandbox", created_by: alice, slug: "alice-co" });
    expect(row.ledger_signing_key_enc).toEqual({ k: "x" });
    expect(await ownerRole(row.id, alice)).toBe("owner");
  });

  it("refuses a fourth workspace after three have been created", async () => {
    await createOrgAs(alice, "Alice Two", "alice-two");
    await createOrgAs(alice, "Alice Three", "alice-three");
    await expect(createOrgAs(alice, "Alice Four", "alice-four")).rejects.toThrow(/org_limit_reached/);
  });

  it("counts existing organizations only, so deleting one frees a slot", async () => {
    const mine = await db.query<{ id: string }>("select id from public.orgs where created_by = $1 order by created_at limit 1", [alice]);
    await db.query("delete from public.orgs where id = $1", [mine.rows[0].id]);
    const row = await createOrgAs(alice, "Alice Five", "alice-five");
    expect(row.created_by).toBe(alice);
  });

  it("surfaces a duplicate slug as the unique violation", async () => {
    await expect(createOrgAs(bob, "Bob Clash", "alice-five")).rejects.toThrow(/orgs_slug_key|duplicate key/);
  });

  it("rejects an invalid slug on the check constraint", async () => {
    await expect(createOrgAs(bob, "Bob Bad Slug", "A")).rejects.toThrow(/orgs_slug_check|violates check constraint/);
  });

  it("is executable only by the service role", async () => {
    const roles = ["anon", "authenticated", "vestiarion_tenant", "service_role"] as const;
    const result = await db.query<{ role: string; ok: boolean }>(
      `select r.role, has_function_privilege(r.role, 'public.create_org(uuid,uuid,text,text,jsonb)', 'execute') as ok
         from unnest($1::text[]) as r(role)`,
      [roles]
    );
    const byRole = Object.fromEntries(result.rows.map((row) => [row.role, row.ok]));
    expect(byRole).toEqual({ anon: false, authenticated: false, vestiarion_tenant: false, service_role: true });
  });
});

describe("the last-owner guard", () => {
  let orgId: string;

  beforeAll(async () => {
    const row = await createOrgAs(carol, "Carol Co", "carol-co");
    orgId = row.id;
  });

  it("refuses to delete the only owner's membership", async () => {
    await expect(db.query("delete from public.memberships where org_id = $1 and user_id = $2", [orgId, carol]))
      .rejects.toThrow(/last owner/);
  });

  it("refuses to demote the only owner", async () => {
    await expect(
      db.query("update public.memberships set role = 'admin' where org_id = $1 and user_id = $2", [orgId, carol])
    ).rejects.toThrow(/last owner/);
  });

  it("allows demoting an owner once a second owner exists", async () => {
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgId, bob]);
    await db.query("update public.memberships set role = 'admin' where org_id = $1 and user_id = $2", [orgId, carol]);
    expect(await ownerRole(orgId, carol)).toBe("admin");
    expect(await ownerRole(orgId, bob)).toBe("owner");
  });

  it("still cascades when the organization itself is deleted, last owner included", async () => {
    await expect(db.query("delete from public.orgs where id = $1", [orgId])).resolves.toBeDefined();
    const remaining = await db.query("select 1 from public.memberships where org_id = $1", [orgId]);
    expect(remaining.rows).toHaveLength(0);
  });
});

describe("0020 is idempotent", () => {
  it("replays every migration twice on a fresh database without error", async () => {
    const fresh = await createDatabase();
    await applyMigrations(fresh);
    await applyMigrations(fresh);
    await fresh.close();
  }, 60_000);
});
