import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asServiceRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0035: `orgs.ledger_retired_keys`, the public halves of the keys a
 * workspace signed with before its current one, in the order they were
 * retired: [{ id, publicKeyPem, retiredAt }]. Public material only, written
 * by the service role in the same update that replaces
 * ledger_signing_key_enc. `orgs` is a platform table with no tenant access
 * at all (0015/0018), so rotation never runs as the tenant role.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const RETIRED = [{ id: "abc", publicKeyPem: "-----BEGIN PUBLIC KEY-----…", retiredAt: "2026-09-30T00:00:00Z" }];

describe("orgs.ledger_retired_keys (0035)", () => {
  it("is a jsonb column, not null, defaulting to an empty array", async () => {
    const column = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      "select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'orgs' and column_name = 'ledger_retired_keys'"
    );
    expect(column.rows).toEqual([{ data_type: "jsonb", is_nullable: "NO", column_default: "'[]'::jsonb" }]);

    const orgId = await createOrg(db, "fresh-retired-keys-co");
    const row = await db.query<{ ledger_retired_keys: unknown }>("select ledger_retired_keys from public.orgs where id = $1", [orgId]);
    expect(row.rows[0].ledger_retired_keys).toEqual([]);
  });

  it("lets the service role set it, in the same update as ledger_signing_key_enc", async () => {
    const orgId = await createOrg(db, "rotate-retired-keys-co");

    const updated = await asServiceRole(db, (tx) =>
      tx.query<{ id: string }>(
        "update public.orgs set ledger_retired_keys = $2::jsonb, ledger_signing_key_enc = ledger_signing_key_enc where id = $1 returning id",
        [orgId, JSON.stringify(RETIRED)]
      )
    );
    expect(updated.rows).toEqual([{ id: orgId }]);

    const row = await db.query<{ ledger_retired_keys: unknown }>("select ledger_retired_keys from public.orgs where id = $1", [orgId]);
    expect(row.rows[0].ledger_retired_keys).toEqual(RETIRED);
  });

  it("refuses a non-array value", async () => {
    const orgId = await createOrg(db, "bad-retired-keys-co");

    await expect(
      db.query("update public.orgs set ledger_retired_keys = $2::jsonb where id = $1", [orgId, JSON.stringify({ id: "abc" })])
    ).rejects.toThrow(/orgs_ledger_retired_keys_is_array/);
  });

  it("is closed to the tenant role, as orgs always has been", async () => {
    const orgId = await createOrg(db, "tenant-retired-keys-co");

    await expect(
      asTenant(db, orgId, (tx) => tx.query("update public.orgs set ledger_retired_keys = $2::jsonb where id = $1", [orgId, JSON.stringify(RETIRED)]))
    ).rejects.toThrow(/permission denied/);
  });

  it("is idempotent across a replay of every migration, keeping the value", async () => {
    const orgId = await createOrg(db, "replay-retired-keys-co");
    await db.query("update public.orgs set ledger_retired_keys = $2::jsonb where id = $1", [orgId, JSON.stringify(RETIRED)]);

    await applyMigrations(db);

    const row = await db.query<{ ledger_retired_keys: unknown }>("select ledger_retired_keys from public.orgs where id = $1", [orgId]);
    expect(row.rows[0].ledger_retired_keys).toEqual(RETIRED);
  });
});
