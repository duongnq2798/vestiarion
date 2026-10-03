import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0063 (docs/superpowers/specs/2026-10-03-payment-notices-design.md R1, R4): a counterparty's address for
 * payment notices, optional and shaped like an email address; a payment intent's notice claim; and a migration that
 * runs again without harm, as db:migrate runs every file.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const counterparty = (orgId: string, name: string, email: string | null) =>
  db.query<{ id: string }>("insert into public.counterparties (org_id, name, role, chain, notice_email) values ($1, $2, 'vendor', 'ARC-TESTNET', $3) returning id", [
    orgId,
    name,
    email,
  ]);

describe("payment notices (0063)", () => {
  it("lets a counterparty carry an address for payment notices, or none", async () => {
    const orgId = await createOrg(db, "notices-email");
    await counterparty(orgId, "Northstar Studio", "linh@example.com");
    await counterparty(orgId, "No Notices", null);
    const rows = (await db.query<{ name: string; notice_email: string | null }>("select name, notice_email from public.counterparties where org_id = $1 order by name", [orgId])).rows;
    expect(rows).toEqual([
      { name: "No Notices", notice_email: null },
      { name: "Northstar Studio", notice_email: "linh@example.com" },
    ]);
  });

  it("refuses an address that is not shaped like one", async () => {
    const orgId = await createOrg(db, "notices-shape");
    for (const bad of ["not-an-email", "two@@example.com", "spaces in@example.com", "a@b", `${"x".repeat(250)}@example.com`]) {
      await expect(counterparty(orgId, `Bad ${bad.length}`, bad), bad).rejects.toThrow(/counterparties_notice_email_check/);
    }
  });

  it("claims a payment intent for its notice, and indexes the notices still owed", async () => {
    const column = (await db.query("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payment_intents' and column_name = 'notice_sent_at'")).rows;
    expect(column).toHaveLength(1);
    const index = (await db.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'payment_intents_notice_due'")).rows;
    expect(index[0]?.indexdef).toContain("WHERE ((status = 'confirmed'::text) AND (notice_sent_at IS NULL))");
  });

  it("is written by its own workspace's tenant requests, as the rest of the counterparty", async () => {
    const mine = await createOrg(db, "notices-tenant-a");
    const theirs = await createOrg(db, "notices-tenant-b");
    const id = (await counterparty(theirs, "Theirs", "theirs@example.com")).rows[0].id;
    const changed = await asTenant(db, mine, async (tx) => (await tx.query("update public.counterparties set notice_email = 'x@example.com' where id = $1 returning id", [id])).rows);
    expect(changed).toHaveLength(0);
  });

  it("keeps when the address was set: on insert, on a change, and none once cleared (R7)", async () => {
    const orgId = await createOrg(db, "notices-set-at");
    const id = (await counterparty(orgId, "Set At", "first@example.com")).rows[0].id;
    const read = async () =>
      (await db.query<{ notice_email_set_at: string | null }>("select notice_email_set_at from public.counterparties where id = $1", [id])).rows[0].notice_email_set_at;
    const first = await read();
    expect(first).not.toBeNull();
    // Another column changing leaves it as it was.
    await db.query("update public.counterparties set jurisdiction = 'US' where id = $1", [id]);
    expect(await read()).toEqual(first);
    await db.query("update public.counterparties set notice_email = null where id = $1", [id]);
    expect(await read()).toBeNull();
    await db.query("update public.counterparties set notice_email = 'second@example.com' where id = $1", [id]);
    expect(await read()).not.toBeNull();
  });

  it("runs again without harm", async () => {
    await expect(applyMigrations(db, (file) => file.startsWith("0063_"))).resolves.toBeUndefined();
    const constraints = (await db.query("select 1 from pg_constraint where conname = 'counterparties_notice_email_check'")).rows;
    expect(constraints).toHaveLength(1);
  });
});
