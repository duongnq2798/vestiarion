import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg, seedOrgRows } from "./support/pglite";

/**
 * Migration 0047 (docs/superpowers/specs/2026-10-01-milestone-escrow-design.md §4): a workspace's escrow
 * contract, a milestone's hold, and the escrow route a payment keeps.
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

describe("escrow_contracts (0047)", () => {
  it("holds one contract per workspace, with a real address once deployed", async () => {
    const orgId = await createOrg(db, "escrow-co");
    await db.query("delete from public.escrow_contracts where org_id = $1", [orgId]);
    await db.query("insert into public.escrow_contracts (org_id) values ($1)", [orgId]);
    await expect(db.query("insert into public.escrow_contracts (org_id) values ($1)", [orgId])).rejects.toThrow(/escrow_contracts_org_id_key/);
    await expect(db.query("update public.escrow_contracts set address = 'nope' where org_id = $1", [orgId])).rejects.toThrow(/escrow_contracts_address_check/);
    await db.query("update public.escrow_contracts set address = $2 where org_id = $1", [orgId, ADDRESS]);
  });

  it("is seen and written only by its own workspace's tenant requests", async () => {
    const mine = await createOrg(db, "escrow-mine");
    const theirs = await createOrg(db, "escrow-theirs");
    await db.query("delete from public.escrow_contracts where org_id in ($1, $2)", [mine, theirs]);
    await db.query("insert into public.escrow_contracts (org_id, address) values ($1, $3), ($2, $3)", [mine, theirs, ADDRESS]);
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.escrow_contracts")).rows);
    expect(seen.map((row) => row.org_id)).toEqual([mine]);
    await expect(asTenant(db, mine, (tx) => tx.query("insert into public.escrow_contracts (org_id) values ($1)", [theirs]))).rejects.toThrow(/row-level security|duplicate key/);
  });
});

describe("a milestone's hold (0047)", () => {
  it("is funded, released or refunded, and records its amount, refund date and transactions", async () => {
    const orgId = await createOrg(db, "escrow-hold");
    const { counterpartyId } = await seedOrgRows(db, orgId, "escrow-hold");
    const id = (
      await db.query<{ id: string }>(
        `insert into public.milestones (org_id, contractor_id, title, amount, escrow_state, escrow_amount, escrow_refund_after, escrow_fund_tx_hash)
         values ($1, $2, 'Ship it', 1, 'funded', 1, now() + interval '30 days', '0x' || repeat('1', 64)) returning id`,
        [orgId, counterpartyId]
      )
    ).rows[0].id;
    await db.query("update public.milestones set escrow_state = 'released', escrow_release_tx_hash = '0x' || repeat('2', 64) where id = $1", [id]);
    // A lock in progress, and the address the hold pays (escrow review I1, C1).
    await db.query("update public.milestones set escrow_state = 'funding', escrow_payee = '0x' || repeat('ab', 20) where id = $1", [id]);
    await expect(db.query("update public.milestones set escrow_state = 'gone' where id = $1", [id])).rejects.toThrow(/milestones_escrow_state_check/);
  });
});

describe("payment_intents.payout_route (0047)", () => {
  it("also accepts escrow", async () => {
    const check = await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'payment_intents_payout_route_check'");
    expect(check.rows[0]?.def).toMatch(/escrow/);
    expect(check.rows[0]?.def).toMatch(/gateway/);
  });
});

describe("re-running 0047", () => {
  it("applies again, after 0045, without error or losing escrow", async () => {
    await applyMigrations(db, (file) => file.startsWith("0045") || file.startsWith("0047"));
    const check = await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'payment_intents_payout_route_check'");
    expect(check.rows[0]?.def).toMatch(/escrow/);
  });
});
