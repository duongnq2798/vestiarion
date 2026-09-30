import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0034: `counterparties.sample` marks a counterparty loaded as an
 * example (sample-data design S2), and a partial unique index allows one
 * sample set per workspace (S3). The loader and the removal run as the tenant
 * role, so it must be able to insert and delete sample rows of its own
 * organization, and the removal's cascade must take the invoices and
 * milestones with them.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const insertSample = (orgId: string, name: string) =>
  asTenant(db, orgId, (tx) =>
    tx.query<{ id: string }>(
      "insert into public.counterparties (org_id, name, role, chain, sample) values ($1, $2, 'vendor', 'ARC-TESTNET', true) returning id",
      [orgId, name]
    )
  );

describe("counterparties.sample (0034)", () => {
  it("is a boolean, not null, false by default", async () => {
    const column = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      "select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'counterparties' and column_name = 'sample'"
    );
    expect(column.rows).toEqual([{ data_type: "boolean", is_nullable: "NO", column_default: "false" }]);

    const orgId = await createOrg(db, "sample-default");
    const row = await asTenant(db, orgId, (tx) =>
      tx.query<{ sample: boolean }>("insert into public.counterparties (org_id, name, role) values ($1, 'Acme', 'vendor') returning sample", [orgId])
    );
    expect(row.rows).toEqual([{ sample: false }]);
  });

  it("refuses a second sample counterparty with the same name in the same workspace", async () => {
    const orgId = await createOrg(db, "sample-twice");
    await insertSample(orgId, "Northwind Hosting");
    await expect(insertSample(orgId, "Northwind Hosting")).rejects.toThrow(/counterparties_one_sample_set/);
  });

  it("allows the same sample name in another workspace, and a person's own counterparty of that name", async () => {
    const first = await createOrg(db, "sample-a");
    const second = await createOrg(db, "sample-b");
    await insertSample(first, "Northwind Hosting");
    await expect(insertSample(second, "Northwind Hosting")).resolves.toBeDefined();
    const own = await asTenant(db, first, (tx) =>
      tx.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Northwind Hosting', 'vendor') returning id", [first])
    );
    expect(own.rows).toHaveLength(1);
  });

  it("lets the tenant delete its sample counterparties, taking their invoices and milestones with them", async () => {
    const orgId = await createOrg(db, "sample-remove");
    const vendor = (await insertSample(orgId, "Kestrel Print Co")).rows[0].id;
    const contractor = (
      await asTenant(db, orgId, (tx) =>
        tx.query<{ id: string }>(
          "insert into public.counterparties (org_id, name, role, sample) values ($1, 'Pinecrest Engineering — Backend Contractor', 'contractor', true) returning id",
          [orgId]
        )
      )
    ).rows[0].id;
    await asTenant(db, orgId, async (tx) => {
      await tx.query(
        "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 180, now())",
        [orgId, vendor]
      );
      await tx.query("insert into public.milestones (org_id, contractor_id, title, amount) values ($1, $2, 'API module', 1200)", [orgId, contractor]);
    });

    const removed = await asTenant(db, orgId, (tx) =>
      tx.query<{ id: string }>("delete from public.counterparties where sample returning id")
    );
    expect(removed.rows).toHaveLength(2);

    const left = await db.query<{ invoices: number; milestones: number }>(
      "select (select count(*)::int from public.invoices where org_id = $1) as invoices, (select count(*)::int from public.milestones where org_id = $1) as milestones",
      [orgId]
    );
    expect(left.rows).toEqual([{ invoices: 0, milestones: 0 }]);
  });
});
