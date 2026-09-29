import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg, createUser, seedOrgRows } from "./support/pglite";

/**
 * Migration 0026 (notifications design N4, N6): a per-member switch for
 * whether the waiting-decision digest reaches them, and when an invoice's
 * waiting members were last told about it.
 */

let db: PGlite;
let owner: string;
let orgId: string, otherOrgId: string, counterpartyId: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);

  owner = await createUser(db, "owner@example.com");
  orgId = await createOrg(db, "notify-co");
  await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgId, owner]);
  const seeded = await seedOrgRows(db, orgId, "notify");
  counterpartyId = seeded.counterpartyId;

  otherOrgId = await createOrg(db, "notify-other-co");
  await seedOrgRows(db, otherOrgId, "notify-other");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("memberships.notify_email", () => {
  it("an existing membership reads true after the migration", async () => {
    const row = (await db.query<{ notify_email: boolean }>(
      "select notify_email from public.memberships where org_id = $1 and user_id = $2", [orgId, owner]
    )).rows[0];
    expect(row.notify_email).toBe(true);
  });

  it("an insert without it defaults to true", async () => {
    const admin = await createUser(db, "admin-default@example.com");
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'admin')", [orgId, admin]);
    const row = (await db.query<{ notify_email: boolean }>(
      "select notify_email from public.memberships where org_id = $1 and user_id = $2", [orgId, admin]
    )).rows[0];
    expect(row.notify_email).toBe(true);
  });

  it("cannot be set to null", async () => {
    const approver = await createUser(db, "approver-null@example.com");
    await expect(
      db.query("insert into public.memberships (org_id, user_id, role, notify_email) values ($1, $2, 'approver', null)", [orgId, approver])
    ).rejects.toThrow();
  });
});

describe("invoices.notified_at", () => {
  it("is nullable with no default", async () => {
    const row = (await db.query<{ notified_at: Date | null }>(
      "select notified_at from public.invoices where org_id = $1 limit 1", [orgId]
    )).rows[0];
    expect(row.notified_at).toBeNull();
  });

  it("the tenant role can update it on its own invoice, and cannot on another org's", async () => {
    const invoiceId = (await db.query<{ id: string }>(
      `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status)
       values ($1, 'payable', $2, 1, now(), 'held') returning id`,
      [orgId, counterpartyId]
    )).rows[0].id;

    await asTenant(db, orgId, (tx) =>
      tx.query("update public.invoices set notified_at = now() where id = $1", [invoiceId]));
    const updated = (await db.query<{ notified_at: Date | null }>(
      "select notified_at from public.invoices where id = $1", [invoiceId]
    )).rows[0];
    expect(updated.notified_at).toBeTruthy();

    const otherResult = await asTenant(db, otherOrgId, (tx) =>
      tx.query("update public.invoices set notified_at = now() where id = $1", [invoiceId]));
    expect(otherResult.affectedRows ?? 0).toBe(0);
    const stillSame = (await db.query<{ notified_at: Date | null }>(
      "select notified_at from public.invoices where id = $1", [invoiceId]
    )).rows[0];
    expect(stillSame.notified_at).toEqual(updated.notified_at);
  });
});

describe("replaying 0026", () => {
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
