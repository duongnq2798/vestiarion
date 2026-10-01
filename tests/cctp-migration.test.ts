import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0044 (docs/superpowers/specs/2026-10-01-cctp-payouts-design.md X1, X8): a payee's chain is
 * one Vestiarion can pay on, and a payment intent records where a bridged payment was minted.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("counterparties.chain (0044)", () => {
  it("is Arc testnet or a chain CCTP pays to from it", async () => {
    const orgId = await createOrg(db, "chains-co");
    for (const chain of ["ARC-TESTNET", "BASE-SEPOLIA", "ARB-SEPOLIA", "ETH-SEPOLIA"]) {
      await db.query("insert into public.counterparties (org_id, name, role, chain) values ($1, $2, 'vendor', $3)", [orgId, `Payee ${chain}`, chain]);
    }
    await expect(
      db.query("insert into public.counterparties (org_id, name, role, chain) values ($1, 'Elsewhere', 'vendor', 'POLYGON-AMOY')", [orgId])
    ).rejects.toThrow(/counterparties_chain_check/);
  });
});

describe("payment_intents (0044)", () => {
  it("records a bridged payment's destination, its mint and its fee", async () => {
    const columns = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'payment_intents' and column_name in ('destination_chain', 'mint_tx_hash', 'bridge_fee') order by 1"
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(["bridge_fee", "destination_chain", "mint_tx_hash"]);
  });
});
