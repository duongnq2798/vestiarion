import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asServiceRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0073 (docs/superpowers/specs/2026-10-05-three-way-match-design.md M2): whether a counterparty needs a
 * purchase order. Every counterparty needs one unless the business says otherwise, as the written policy has always
 * required, and the workspace's own members read and change it like the rest of the row.
 */

let db: PGlite;
let org: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  org = await createOrg(db, "purchase-orders");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("counterparties.purchase_order_required", () => {
  it("is true for a counterparty added without saying otherwise", async () => {
    const added = await asServiceRole(db, (tx) =>
      tx.query<{ purchase_order_required: boolean }>(
        "insert into public.counterparties (org_id, name, role) values ($1, 'Centronex', 'vendor') returning purchase_order_required",
        [org]
      )
    );
    expect(added.rows[0].purchase_order_required).toBe(true);
  });

  it("is never null", async () => {
    await expect(
      asServiceRole(db, (tx) =>
        tx.query("insert into public.counterparties (org_id, name, role, purchase_order_required) values ($1, 'STM', 'vendor', null)", [org])
      )
    ).rejects.toThrow(/null value/);
  });

  it("is the workspace's to change, as the rest of the row is", async () => {
    const changed = await asTenant(db, org, (tx) =>
      tx.query<{ purchase_order_required: boolean }>(
        "update public.counterparties set purchase_order_required = false where org_id = $1 and name = 'Centronex' returning purchase_order_required",
        [org]
      )
    );
    expect(changed.rows).toEqual([{ purchase_order_required: false }]);
  });
});
