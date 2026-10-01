import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg, seedOrgRows } from "./support/pglite";

/**
 * Migration 0048 (docs/superpowers/specs/2026-10-01-eurc-swap-design.md S8): a swap of USDC for EURC
 * made to pay a EURC invoice, recorded before anything is sent so a lost answer is resumed, not repeated.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const CALL = "0x" + "ab".repeat(68);

async function swap(orgId: string, invoiceId: string, state = "submitted") {
  return (
    await db.query<{ id: string }>(
      `insert into public.fx_swaps (org_id, invoice_id, state, usdc_in, eurc_minimum, eurc_estimated, usdc_per_eurc, cost_percent, provider, adapter, call_data, deadline)
       values ($1, $2, $3, 2.5, 2.0, 2.06, 1.2161, 0.31, 'lifi', '0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b', $4, now() + interval '10 minutes') returning id`,
      [orgId, invoiceId, state, CALL]
    )
  ).rows[0].id;
}

describe("fx_swaps (0048)", () => {
  it("records a swap's figures, its calls and how it ended", async () => {
    const orgId = await createOrg(db, "swap-co");
    const { invoiceId } = await seedOrgRows(db, orgId, "swap-co");
    const id = await swap(orgId, invoiceId);
    await db.query(
      `update public.fx_swaps set state = 'confirmed', eurc_received = 2.061, approve_tx_id = 'a', approve_tx_hash = '0x1', swap_tx_id = 's', swap_tx_hash = '0x2', updated_at = now() where id = $1`,
      [id]
    );
    await expect(db.query("update public.fx_swaps set state = 'lost' where id = $1", [id])).rejects.toThrow(/fx_swaps_state_check/);
    const row = (await db.query<{ usdc_in: string; eurc_received: string }>("select usdc_in, eurc_received from public.fx_swaps where id = $1", [id])).rows[0];
    expect(row).toEqual({ usdc_in: "2.500000", eurc_received: "2.061000" });
  });

  it("allows one swap in flight per invoice, and any number that have ended", async () => {
    const orgId = await createOrg(db, "swap-one");
    const { invoiceId } = await seedOrgRows(db, orgId, "swap-one");
    await swap(orgId, invoiceId, "failed");
    await swap(orgId, invoiceId, "confirmed");
    await swap(orgId, invoiceId);
    await expect(swap(orgId, invoiceId)).rejects.toThrow(/fx_swaps_one_submitted/);
  });

  it("goes with its invoice", async () => {
    const orgId = await createOrg(db, "swap-gone");
    const { invoiceId } = await seedOrgRows(db, orgId, "swap-gone");
    await swap(orgId, invoiceId, "confirmed");
    await db.query("delete from public.payment_receipts where invoice_id = $1", [invoiceId]);
    await db.query("delete from public.payment_intents where source_id = $1", [invoiceId]);
    await db.query("delete from public.invoices where id = $1", [invoiceId]);
    const left = await db.query("select 1 from public.fx_swaps where invoice_id = $1", [invoiceId]);
    expect(left.rows).toHaveLength(0);
  });

  it("is seen and written only by its own workspace's tenant requests", async () => {
    const mine = await createOrg(db, "swap-mine");
    const theirs = await createOrg(db, "swap-theirs");
    const { invoiceId: myInvoice } = await seedOrgRows(db, mine, "swap-mine");
    const { invoiceId: theirInvoice } = await seedOrgRows(db, theirs, "swap-theirs");
    await swap(mine, myInvoice, "confirmed");
    await swap(theirs, theirInvoice, "confirmed");
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ org_id: string }>("select distinct org_id from public.fx_swaps")).rows);
    expect(seen.map((row) => row.org_id)).toEqual([mine]);
    await expect(
      asTenant(db, mine, (tx) =>
        tx.query(
          `insert into public.fx_swaps (org_id, invoice_id, state, usdc_in, eurc_minimum, eurc_estimated, usdc_per_eurc, cost_percent, adapter, call_data, deadline)
           values ($1, $2, 'confirmed', 1, 1, 1, 1, 0, '0x', '0x', now())`,
          [theirs, theirInvoice]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });
});

describe("re-running 0048", () => {
  it("applies again without error or losing a swap", async () => {
    const orgId = await createOrg(db, "swap-again");
    const { invoiceId } = await seedOrgRows(db, orgId, "swap-again");
    const id = await swap(orgId, invoiceId, "confirmed");
    await applyMigrations(db, (file) => file.startsWith("0048"));
    const left = await db.query("select 1 from public.fx_swaps where id = $1", [id]);
    expect(left.rows).toHaveLength(1);
  });
});
