import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0032: `accounts.balance_synced_at`, when the balance was last read
 * from the chain, and `accounts.balance_refresh_claimed_at`, the console
 * refresh's claim, so only one request at a time asks Circle. The tenant role writes it beside `balance` — the reconcile
 * stage and the console's balance refresh both run as that role — so it has to
 * be able to update it, for its own organization's rows only.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function account(orgId: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into public.accounts (org_id, name, kind, chain, balance) values ($1, 'Operating', 'operating', 'ARC-TESTNET', 100) returning id",
    [orgId]
  );
  return result.rows[0].id;
}

/** The console refresh's claim, as PostgREST runs it for the tenant: at most one winner per 30 seconds. */
const claim = (orgId: string, id: string, at: string) =>
  asTenant(db, orgId, (tx) =>
    tx.query<{ id: string }>(
      `update public.accounts set balance_refresh_claimed_at = $2::timestamptz
        where id = $1 and (balance_refresh_claimed_at is null or balance_refresh_claimed_at < $2::timestamptz - interval '30 seconds')
        returning id`,
      [id, at]
    )
  );

describe("accounts.balance_refresh_claimed_at (0032)", () => {
  it("is a nullable timestamptz", async () => {
    const column = await db.query<{ data_type: string; is_nullable: string }>(
      "select data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'accounts' and column_name = 'balance_refresh_claimed_at'"
    );
    expect(column.rows).toEqual([{ data_type: "timestamp with time zone", is_nullable: "YES" }]);
  });

  it("lets exactly one tenant request claim the account within 30 seconds, then the next after", async () => {
    const orgId = await createOrg(db, "claim-co");
    const id = await account(orgId);

    expect((await claim(orgId, id, "2026-09-30T12:00:00Z")).rows).toEqual([{ id }]);
    expect((await claim(orgId, id, "2026-09-30T12:00:01Z")).rows).toEqual([]);
    expect((await claim(orgId, id, "2026-09-30T12:00:29Z")).rows).toEqual([]);
    expect((await claim(orgId, id, "2026-09-30T12:00:31Z")).rows).toEqual([{ id }]);
  });

  it("never lets one organization claim another's account", async () => {
    const mine = await createOrg(db, "claim-mine-co");
    const theirs = await createOrg(db, "claim-theirs-co");
    const id = await account(theirs);

    expect((await claim(mine, id, "2026-09-30T12:00:00Z")).rows).toEqual([]);
  });
});

describe("accounts.balance_synced_at (0032)", () => {
  it("is a nullable timestamptz, empty for existing rows", async () => {
    const column = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      "select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'accounts' and column_name = 'balance_synced_at'"
    );
    expect(column.rows).toEqual([{ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null }]);

    const orgId = await createOrg(db, "fresh-co");
    const id = await account(orgId);
    const row = await db.query<{ balance_synced_at: string | null }>("select balance_synced_at from public.accounts where id = $1", [id]);
    expect(row.rows[0].balance_synced_at).toBeNull();
  });

  it("lets the tenant role write it with the balance, for its own organization", async () => {
    const orgId = await createOrg(db, "synced-co");
    const id = await account(orgId);
    const syncedAt = "2026-09-30T12:00:00.000Z";

    const updated = await asTenant(db, orgId, (tx) =>
      tx.query("update public.accounts set balance = 120, balance_synced_at = $2 where id = $1", [id, syncedAt])
    );
    expect(updated.affectedRows).toBe(1);

    const read = await asTenant(db, orgId, (tx) =>
      tx.query<{ balance: string; balance_synced_at: Date }>("select balance, balance_synced_at from public.accounts where id = $1", [id])
    );
    expect(Number(read.rows[0].balance)).toBe(120);
    expect(new Date(read.rows[0].balance_synced_at).toISOString()).toBe(syncedAt);
  });

  it("lets the tenant role write it alone, when the balance did not change", async () => {
    const orgId = await createOrg(db, "unchanged-co");
    const id = await account(orgId);

    const updated = await asTenant(db, orgId, (tx) => tx.query("update public.accounts set balance_synced_at = now() where id = $1", [id]));

    expect(updated.affectedRows).toBe(1);
  });

  it("never reaches another organization's row", async () => {
    const mine = await createOrg(db, "mine-co");
    const theirs = await createOrg(db, "theirs-co");
    const id = await account(theirs);

    const updated = await asTenant(db, mine, (tx) => tx.query("update public.accounts set balance_synced_at = now() where id = $1", [id]));

    expect(updated.affectedRows).toBe(0);
    const row = await db.query<{ balance_synced_at: string | null }>("select balance_synced_at from public.accounts where id = $1", [id]);
    expect(row.rows[0].balance_synced_at).toBeNull();
  });

  it("gives the browser roles nothing", async () => {
    await expect(asRole(db, "authenticated", (tx) => tx.query("update public.accounts set balance_synced_at = now()"))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "anon", (tx) => tx.query("select balance_synced_at from public.accounts"))).rejects.toThrow(/permission denied/);
  });

  it("is idempotent across a replay of every migration, keeping the value", async () => {
    const orgId = await createOrg(db, "replay-co");
    const id = await account(orgId);
    await db.query("update public.accounts set balance_synced_at = '2026-09-30T12:00:00Z' where id = $1", [id]);

    await applyMigrations(db);

    const row = await db.query<{ balance_synced_at: Date }>("select balance_synced_at from public.accounts where id = $1", [id]);
    expect(new Date(row.rows[0].balance_synced_at).toISOString()).toBe("2026-09-30T12:00:00.000Z");
  });
});
