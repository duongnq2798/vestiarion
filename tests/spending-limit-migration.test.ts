import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0062 (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md §5): a workspace's spending
 * limit contract on Arc, its setup steps, and whether the agent's payments go through it.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const ADDRESS = "0x5aF3107A4000000000000000000000000000e5c0";
const AGENT = "0x5aF3107A4000000000000000000000000000a9e7";

describe("spending_limit_contracts (0062)", () => {
  it("holds one contract per workspace, not enforced until set up, with real addresses once known", async () => {
    const orgId = await createOrg(db, "limit-co");
    await db.query("delete from public.spending_limit_contracts where org_id = $1", [orgId]);
    const row = (await db.query<{ enforced: boolean }>("insert into public.spending_limit_contracts (org_id) values ($1) returning enforced", [orgId])).rows[0];
    expect(row.enforced).toBe(false);
    await expect(db.query("insert into public.spending_limit_contracts (org_id) values ($1)", [orgId])).rejects.toThrow(/spending_limit_contracts_org_id_key/);
    await expect(db.query("update public.spending_limit_contracts set address = 'nope' where org_id = $1", [orgId])).rejects.toThrow(/spending_limit_contracts_address_check/);
    await expect(db.query("update public.spending_limit_contracts set agent_address = '0x12' where org_id = $1", [orgId])).rejects.toThrow(
      /spending_limit_contracts_agent_address_check/
    );
  });

  it("is enforced only with a contract, an agent and an approval behind it", async () => {
    const orgId = await createOrg(db, "limit-enforced");
    await db.query("delete from public.spending_limit_contracts where org_id = $1", [orgId]);
    await db.query("insert into public.spending_limit_contracts (org_id, address) values ($1, $2)", [orgId, ADDRESS]);
    await expect(db.query("update public.spending_limit_contracts set enforced = true where org_id = $1", [orgId])).rejects.toThrow(
      /spending_limit_contracts_enforced_check/
    );
    await db.query("update public.spending_limit_contracts set agent_address = $2, approve_tx_id = 'tx-approve' where org_id = $1", [orgId, AGENT]);
    await db.query("update public.spending_limit_contracts set enforced = true where org_id = $1", [orgId]);
  });

  it("is seen and written only by its own workspace's tenant requests, and never by a browser role", async () => {
    const mine = await createOrg(db, "limit-mine");
    const theirs = await createOrg(db, "limit-theirs");
    await db.query("delete from public.spending_limit_contracts where org_id in ($1, $2)", [mine, theirs]);
    await db.query("insert into public.spending_limit_contracts (org_id, address) values ($1, $3), ($2, $3)", [mine, theirs, ADDRESS]);
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.spending_limit_contracts")).rows);
    expect(seen.map((row) => row.org_id)).toEqual([mine]);
    await expect(asTenant(db, mine, (tx) => tx.query("insert into public.spending_limit_contracts (org_id) values ($1)", [theirs]))).rejects.toThrow(
      /row-level security|duplicate key/
    );
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select * from public.spending_limit_contracts"))).rejects.toThrow(/permission denied/);
    }
  });

  it("replays without error, keeping its rows", async () => {
    const orgId = await createOrg(db, "limit-replay");
    await db.query("delete from public.spending_limit_contracts where org_id = $1", [orgId]);
    await db.query("insert into public.spending_limit_contracts (org_id, address) values ($1, $2)", [orgId, ADDRESS]);
    await applyMigrations(db);
    const kept = await db.query<{ address: string }>("select address from public.spending_limit_contracts where org_id = $1", [orgId]);
    expect(kept.rows).toEqual([{ address: ADDRESS }]);
  });
});
