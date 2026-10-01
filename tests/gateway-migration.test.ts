import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0045 (docs/superpowers/specs/2026-10-01-gateway-payouts-design.md G1, G2): a workspace's
 * Gateway signer, kept apart from its accounts, and the route a payment intent keeps from its first attempt.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const SIGNER = "0x5aF3107A4000000000000000000000000000b0b0";

describe("gateway_signers (0045)", () => {
  it("holds one signer per workspace, with a real address", async () => {
    const orgId = await createOrg(db, "gateway-co");
    await db.query("insert into public.gateway_signers (org_id, circle_wallet_id, address) values ($1, 'w-1', $2)", [orgId, SIGNER]);
    await expect(db.query("insert into public.gateway_signers (org_id, circle_wallet_id, address) values ($1, 'w-2', $2)", [orgId, SIGNER])).rejects.toThrow(/gateway_signers_org_id_key/);
    const other = await createOrg(db, "gateway-bad-co");
    await expect(db.query("insert into public.gateway_signers (org_id, circle_wallet_id, address) values ($1, 'w-3', 'not-an-address')", [other])).rejects.toThrow(/gateway_signers_address_check/);
  });

  it("is seen only by its own workspace's tenant requests", async () => {
    const mine = await createOrg(db, "gateway-mine");
    const theirs = await createOrg(db, "gateway-theirs");
    await db.query("insert into public.gateway_signers (org_id, circle_wallet_id, address) values ($1, 'w-mine', $2), ($3, 'w-theirs', $2)", [mine, SIGNER, theirs]);
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ circle_wallet_id: string }>("select circle_wallet_id from public.gateway_signers order by 1")).rows);
    expect(seen.map((row) => row.circle_wallet_id)).toEqual(["w-mine"]);
    await expect(
      asTenant(db, mine, (tx) => tx.query("insert into public.gateway_signers (org_id, circle_wallet_id, address) values ($1, 'w-forged', $2)", [theirs, SIGNER]))
    ).rejects.toThrow(/row-level security/);
  });
});

describe("payment_intents.payout_route (0045)", () => {
  it("is CCTP, Gateway or unset", async () => {
    const check = await db.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'payment_intents_payout_route_check'"
    );
    expect(check.rows[0]?.def).toMatch(/cctp/);
    expect(check.rows[0]?.def).toMatch(/gateway/);
    const column = await db.query<{ is_nullable: string }>(
      "select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'payment_intents' and column_name = 'payout_route'"
    );
    expect(column.rows[0]?.is_nullable).toBe("YES");
  });
});

describe("re-running 0045", () => {
  it("applies again without error", async () => {
    await applyMigrations(db, (file) => file.startsWith("0045"));
  });
});
