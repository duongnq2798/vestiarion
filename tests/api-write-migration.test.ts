import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0066 (docs/superpowers/specs/2026-10-03-write-api-design.md §4, R1, R5): a key may write as well as read,
 * and a write's outcome is kept for its `Idempotency-Key` in a platform table only the service role touches.
 */

let db: PGlite;
let orgId: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  orgId = await createOrg(db, "write-api-co");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const remember = (org: string, key: string, status: number | null = 201) =>
  db.query(
    "insert into public.api_idempotency (org_id, idempotency_key, request_hash, status, response) values ($1, $2, $3, $4, $5::jsonb)",
    [org, key, "a".repeat(64), status, status === null ? null : JSON.stringify({ data: { id: "x" } })]
  );

describe("api_idempotency (0066)", () => {
  it("keeps one outcome per key in a workspace", async () => {
    await remember(orgId, "order-1001");
    await expect(remember(orgId, "order-1001")).rejects.toThrow(/api_idempotency_pkey/);
    const other = await createOrg(db, "write-api-other");
    await expect(remember(other, "order-1001")).resolves.toBeTruthy();
  });

  it("holds a claim in flight with no status yet", async () => {
    await remember(orgId, "order-in-flight", null);
    const row = (await db.query<{ status: number | null; completed_at: Date | null }>(
      "select status, completed_at from public.api_idempotency where org_id = $1 and idempotency_key = 'order-in-flight'",
      [orgId]
    )).rows[0];
    expect(row).toEqual({ status: null, completed_at: null });
  });

  it("goes with its workspace", async () => {
    const doomed = await createOrg(db, "write-api-doomed");
    await remember(doomed, "order-gone");
    await db.query("delete from public.orgs where id = $1", [doomed]);
    expect((await db.query("select 1 from public.api_idempotency where org_id = $1", [doomed])).rows).toEqual([]);
  });

  it("lets neither the browser roles nor a tenant read it", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select * from public.api_idempotency"))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, orgId, (tx) => tx.query("select * from public.api_idempotency"))).rejects.toThrow(/permission denied/);
  });

  it("runs again without error or loss, as db:migrate runs every file", async () => {
    const count = async () => (await db.query<{ n: number }>("select count(*)::int as n from public.api_idempotency")).rows[0].n;
    const before = await count();
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0066_api_write.sql"), "utf8"));
    expect(await count()).toBe(before);
    // The widened scope check survives the re-run too.
    await expect(
      db.query("insert into public.api_keys (org_id, name, prefix, secret_hash, scopes) values ($1, 'ci', 'zzzzzzzz', $2, '{read,write}')", [orgId, "b".repeat(64)])
    ).resolves.toBeTruthy();
  });
});
