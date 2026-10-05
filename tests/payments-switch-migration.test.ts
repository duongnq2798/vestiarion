import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0074 (docs/superpowers/specs/2026-10-05-payment-safety-design.md S7, R5): the platform's switch for every
 * payment, one row only the service role reads or writes, so every running deployment sees it at once; and the wallet
 * a payment's send went from, so a send Circle never answered is looked for where it was sent.
 */

let db: PGlite;
let orgId: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  orgId = await createOrg(db, "switch-co");
}, 60_000);

describe("platform_controls (S7)", () => {
  it("holds one row, with payments on", async () => {
    const rows = await db.query<{ id: boolean; payments_disabled_at: string | null }>("select id, payments_disabled_at from public.platform_controls");
    expect(rows.rows).toEqual([{ id: true, payments_disabled_at: null }]);
    await expect(db.query("insert into public.platform_controls (id) values (false)")).rejects.toThrow();
  });

  it("is switched by the service role, with a reason", async () => {
    await asServiceRole(db, (tx) =>
      tx.query("update public.platform_controls set payments_disabled_at = now(), payments_disabled_reason = 'Incident 7' where id")
    );
    const row = await asServiceRole(db, (tx) => tx.query<{ payments_disabled_reason: string }>("select payments_disabled_reason from public.platform_controls"));
    expect(row.rows[0].payments_disabled_reason).toBe("Incident 7");
    await db.query("update public.platform_controls set payments_disabled_at = null, payments_disabled_reason = null where id");
  });

  it("is out of reach of browsers and of a workspace's own requests", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select * from public.platform_controls"))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.platform_controls set payments_disabled_at = null"))).rejects.toThrow(
      /permission denied/
    );
  });
});

describe("payment_intents.sent_wallet_id (R5)", () => {
  it("is empty until a send records the wallet it went from", async () => {
    const column = await db.query<{ is_nullable: string; data_type: string }>(
      "select is_nullable, data_type from information_schema.columns where table_schema = 'public' and table_name = 'payment_intents' and column_name = 'sent_wallet_id'"
    );
    expect(column.rows[0]).toEqual({ is_nullable: "YES", data_type: "text" });
  });
});
