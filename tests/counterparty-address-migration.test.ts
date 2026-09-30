import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0033: `counterparties.address_changed_at`, set when a person edits
 * a counterparty's address, and `address_confirmed_at`, set when a person
 * confirms the new one. The edit and the confirmation run as the tenant role,
 * so it has to be able to write both, for its own organization's rows only.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function counterparty(orgId: string, address: string | null = "0x1111111111111111111111111111111111111111"): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into public.counterparties (org_id, name, role, chain, address) values ($1, 'Acme', 'vendor', 'ARC-TESTNET', $2) returning id",
    [orgId, address]
  );
  return result.rows[0].id;
}

const NEW_ADDRESS = "0x2222222222222222222222222222222222222222";

describe("counterparties.address_changed_at and address_confirmed_at (0033)", () => {
  it.each(["address_changed_at", "address_confirmed_at"])("%s is a nullable timestamptz with no default, empty for a new counterparty", async (name) => {
    const column = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      "select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'counterparties' and column_name = $1",
      [name]
    );
    expect(column.rows).toEqual([{ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null }]);

    const orgId = await createOrg(db, `fresh-${name.replaceAll("_", "-")}`);
    const id = await counterparty(orgId);
    const row = await db.query<Record<string, unknown>>(`select ${name} from public.counterparties where id = $1`, [id]);
    expect(row.rows[0][name]).toBeNull();
  });

  it("lets the tenant change its own counterparty's address, guarded on the old one", async () => {
    const orgId = await createOrg(db, "edit-co");
    const id = await counterparty(orgId);

    const changed = await asTenant(db, orgId, (tx) =>
      tx.query<{ id: string }>(
        "update public.counterparties set address = $2, address_changed_at = now() where id = $1 and address = $3 returning id",
        [id, NEW_ADDRESS, "0x1111111111111111111111111111111111111111"]
      )
    );
    expect(changed.rows).toEqual([{ id }]);

    // The same guard a second time no longer matches: the address moved on.
    const again = await asTenant(db, orgId, (tx) =>
      tx.query("update public.counterparties set address = $2, address_changed_at = now() where id = $1 and address = $3 returning id", [
        id,
        NEW_ADDRESS,
        "0x1111111111111111111111111111111111111111",
      ])
    );
    expect(again.rows).toEqual([]);

    const confirmed = await asTenant(db, orgId, (tx) =>
      tx.query("update public.counterparties set address_confirmed_at = now() where id = $1 returning id", [id])
    );
    expect(confirmed.rows).toEqual([{ id }]);
  });

  it("never reaches another organization's counterparty", async () => {
    const mine = await createOrg(db, "edit-mine-co");
    const theirs = await createOrg(db, "edit-theirs-co");
    const id = await counterparty(theirs);

    const updated = await asTenant(db, mine, (tx) =>
      tx.query("update public.counterparties set address = $2, address_changed_at = now(), address_confirmed_at = now() where id = $1", [id, NEW_ADDRESS])
    );

    expect(updated.affectedRows).toBe(0);
    const row = await db.query<{ address: string; address_changed_at: string | null }>(
      "select address, address_changed_at from public.counterparties where id = $1",
      [id]
    );
    expect(row.rows[0]).toEqual({ address: "0x1111111111111111111111111111111111111111", address_changed_at: null });
  });

  it("gives the browser roles nothing", async () => {
    await expect(asRole(db, "authenticated", (tx) => tx.query("update public.counterparties set address_changed_at = now()"))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "anon", (tx) => tx.query("select address_confirmed_at from public.counterparties"))).rejects.toThrow(/permission denied/);
  });

  it("is idempotent across a replay of every migration, keeping the values", async () => {
    const orgId = await createOrg(db, "replay-address-co");
    const id = await counterparty(orgId);
    await db.query(
      "update public.counterparties set address_changed_at = '2026-09-30T12:00:00Z', address_confirmed_at = '2026-09-30T13:00:00Z' where id = $1",
      [id]
    );

    await applyMigrations(db);

    const row = await db.query<{ address_changed_at: Date; address_confirmed_at: Date }>(
      "select address_changed_at, address_confirmed_at from public.counterparties where id = $1",
      [id]
    );
    expect(new Date(row.rows[0].address_changed_at).toISOString()).toBe("2026-09-30T12:00:00.000Z");
    expect(new Date(row.rows[0].address_confirmed_at).toISOString()).toBe("2026-09-30T13:00:00.000Z");
  });
});
