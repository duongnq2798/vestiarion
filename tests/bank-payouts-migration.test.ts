import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser, seedOrgRows } from "./support/pglite";

/**
 * Migration 0124 (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B11): the workspace's BlindPay customer, a
 * vendor's bank account kept as its bank and last four digits only, one in use per vendor and never edited, the bank
 * payout route, and the readiness probe. A re-run of 0047 then 0124 ends with bank still taken.
 */

let db: PGlite;
let person: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // scripts/migrate.ts re-runs every file: 0047 resets the payout route check, and 0124 widens it again.
  await applyMigrations(db, (file) => file.startsWith("0047_") || file.startsWith("0124_"));
  person = await createUser(db, "owner-bank@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const definition = async (name: string) =>
  (await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1", [name])).rows[0]?.def ?? "";

/** A vendor of the workspace, with the bank account seeding gave it removed, so each test adds its own. */
async function vendor(orgId: string, tag: string): Promise<{ counterpartyId: string; invoiceId: string }> {
  const { counterpartyId, invoiceId } = await seedOrgRows(db, orgId, tag);
  await db.query("update public.counterparty_bank_accounts set removed_at = now() where org_id = $1 and removed_at is null", [orgId]);
  return { counterpartyId, invoiceId };
}

async function account(orgId: string, counterpartyId: string, externalId = "ba_000000000001"): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `insert into public.counterparty_bank_accounts (org_id, counterparty_id, external_id, bank_code, last4, beneficiary_name, added_by)
       values ($1, $2, $3, '012', '9716', 'Ana López', $4) returning id`,
      [orgId, counterpartyId, externalId, person]
    )
  ).rows[0].id;
}

describe("workspace_payout_partners (0124)", () => {
  it("keeps one BlindPay customer per workspace, made only with accepted terms", async () => {
    const orgId = await createOrg(db, "bank-partner");
    await db.query("insert into public.workspace_payout_partners (org_id, tos_id) values ($1, 'to_abcd1234')", [orgId]);
    await expect(db.query("insert into public.workspace_payout_partners (org_id) values ($1)", [orgId])).rejects.toThrow(/workspace_payout_partners_org_provider_key/);
    await db.query("update public.workspace_payout_partners set customer_id = 're_abcd1234', kyb_status = 'approved' where org_id = $1", [orgId]);
    await expect(db.query("update public.workspace_payout_partners set kyb_status = 'fine' where org_id = $1", [orgId])).rejects.toThrow(/kyb_status_check/);
    const other = await createOrg(db, "bank-partner-no-terms");
    await expect(db.query("insert into public.workspace_payout_partners (org_id, customer_id) values ($1, 're_abcd1234')", [other])).rejects.toThrow(/customer_check/);
    await expect(db.query("insert into public.workspace_payout_partners (org_id, provider) values ($1, 'stripe')", [other])).rejects.toThrow(/provider_check/);
  });

  it("takes its customer by an upsert only when the upsert names the terms too", async () => {
    // An INSERT ... ON CONFLICT checks the row it proposes before it finds the conflict: a customer without its terms is
    // refused even for a row that has them, so the set-up writes both (bank payouts B3, as seen live).
    const orgId = await createOrg(db, "bank-partner-upsert");
    await db.query("insert into public.workspace_payout_partners (org_id, tos_id) values ($1, 'to_upsert12345')", [orgId]);
    const upsert = (withTerms: boolean) =>
      db.query(
        `insert into public.workspace_payout_partners (org_id, provider, customer_id${withTerms ? ", tos_id" : ""}) values ($1, 'blindpay', 're_upsert12345'${withTerms ? ", 'to_upsert12345'" : ""})
         on conflict (org_id, provider) do update set customer_id = excluded.customer_id`,
        [orgId]
      );
    await expect(upsert(false)).rejects.toThrow(/workspace_payout_partners_customer_check/);
    await upsert(true);
    expect((await db.query<{ customer_id: string }>("select customer_id from public.workspace_payout_partners where org_id = $1", [orgId])).rows[0].customer_id).toBe("re_upsert12345");
  });

  it("is seen and written only by its own workspace's tenant requests", async () => {
    const mine = await createOrg(db, "bank-partner-mine");
    const theirs = await createOrg(db, "bank-partner-theirs");
    await db.query("insert into public.workspace_payout_partners (org_id, tos_id) values ($1, 'to_mine1234'), ($2, 'to_theirs12')", [mine, theirs]);
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.workspace_payout_partners")).rows);
    expect(seen.map((row) => row.org_id)).toEqual([mine]);
    await expect(asTenant(db, mine, (tx) => tx.query("update public.workspace_payout_partners set kyb_status = 'approved' where org_id = $1", [theirs]))).resolves.toBeTruthy();
    expect((await db.query<{ kyb_status: string | null }>("select kyb_status from public.workspace_payout_partners where org_id = $1", [theirs])).rows[0].kyb_status).toBeNull();
    await expect(asTenant(db, mine, (tx) => tx.query("insert into public.workspace_payout_partners (org_id, provider) values ($1, 'blindpay')", [theirs]))).rejects.toThrow(
      /row-level security|duplicate key/
    );
    await expect(asRole(db, "authenticated", (tx) => tx.query("select * from public.workspace_payout_partners"))).rejects.toThrow(/permission denied/);
  });
});

describe("counterparty_bank_accounts (0124)", () => {
  it("keeps a CLABE's bank code and last four, never more", async () => {
    const orgId = await createOrg(db, "bank-account-shape");
    const { counterpartyId } = await vendor(orgId, "bank-account-shape");
    await account(orgId, counterpartyId);
    const insert = (values: { externalId?: string; bankCode?: string; last4?: string }) =>
      db.query(
        `insert into public.counterparty_bank_accounts (org_id, counterparty_id, external_id, bank_code, last4, beneficiary_name, removed_at)
         values ($1, $2, $3, $4, $5, 'Ana López', now())`,
        [orgId, counterpartyId, values.externalId ?? "ba_000000000009", values.bankCode ?? "012", values.last4 ?? "9716"]
      );
    await expect(insert({ bankCode: "012180" })).rejects.toThrow(/bank_code_check/);
    await expect(insert({ last4: "012180000118359716" })).rejects.toThrow(/last4_check/);
    await expect(insert({ externalId: "032180000118359719" })).rejects.toThrow(/external_id_check/);
  });

  it("has one account in use per vendor: a second waits for the first to be removed", async () => {
    const orgId = await createOrg(db, "bank-account-in-use");
    const { counterpartyId } = await vendor(orgId, "bank-account-in-use");
    const first = await account(orgId, counterpartyId, "ba_000000000101");
    await expect(account(orgId, counterpartyId, "ba_000000000102")).rejects.toThrow(/counterparty_bank_accounts_in_use/);
    await db.query("update public.counterparty_bank_accounts set removed_at = now() where id = $1", [first]);
    expect(await account(orgId, counterpartyId, "ba_000000000102")).toBeTruthy();
  });

  it("is replaced, never edited, and a removed one stays removed", async () => {
    const orgId = await createOrg(db, "bank-account-fixed");
    const { counterpartyId } = await vendor(orgId, "bank-account-fixed");
    const id = await account(orgId, counterpartyId, "ba_000000000201");
    await expect(db.query("update public.counterparty_bank_accounts set last4 = '0000' where id = $1", [id])).rejects.toThrow(/bank_account_fixed/);
    await expect(db.query("update public.counterparty_bank_accounts set beneficiary_name = 'Someone Else' where id = $1", [id])).rejects.toThrow(/bank_account_fixed/);
    await db.query("update public.counterparty_bank_accounts set status = 'approved' where id = $1", [id]);
    await db.query("update public.counterparty_bank_accounts set removed_at = now() where id = $1", [id]);
    await expect(db.query("update public.counterparty_bank_accounts set removed_at = null where id = $1", [id])).rejects.toThrow(/bank_account_removed/);
  });

  it("belongs to a counterparty of the same workspace, and goes with it", async () => {
    const orgId = await createOrg(db, "bank-account-cp");
    const other = await createOrg(db, "bank-account-cp-other");
    const { counterpartyId } = await vendor(other, "bank-account-cp-other");
    await expect(account(orgId, counterpartyId, "ba_000000000301")).rejects.toThrow(/counterparty_bank_accounts_counterparty_fkey/);
  });

  it("is seen only by its own workspace's tenant requests", async () => {
    const mine = await createOrg(db, "bank-account-mine");
    const theirs = await createOrg(db, "bank-account-theirs");
    const a = await vendor(mine, "bank-account-mine");
    const b = await vendor(theirs, "bank-account-theirs");
    await account(mine, a.counterpartyId, "ba_000000000401");
    await account(theirs, b.counterpartyId, "ba_000000000402");
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ external_id: string }>("select external_id from public.counterparty_bank_accounts where removed_at is null")).rows);
    expect(seen.map((row) => row.external_id)).toEqual(["ba_000000000401"]);
  });
});

describe("payment_intents.payout_route (0124)", () => {
  it("takes bank beside cctp, gateway and escrow, after 0047 ran again", async () => {
    const def = await definition("payment_intents_payout_route_check");
    for (const route of ["cctp", "gateway", "escrow", "bank"]) expect(def).toContain(`'${route}'`);
  });
});

describe("re-running every migration with a bank payout on file (0047, 0124)", () => {
  it("never narrows the route check again, so a row paid to a bank does not stop the run", async () => {
    // As on production after the first bank payout: scripts/migrate.ts re-runs every file, and 0047 used to set the check
    // back to cctp, gateway and escrow, which this row refused.
    const orgId = await createOrg(db, "bank-rerun");
    const { invoiceId } = await vendor(orgId, "bank-rerun");
    await db.query(
      `insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination, payout_route)
       values ($1, 'invoice', $2, $3, 'circle', 10, 'blindpay:ba_000000000501', 'bank')
       on conflict (idempotency_key) do nothing`,
      [orgId, invoiceId, `bank-rerun-${invoiceId}`]
    ).catch(async () => {
      // The seeded intent already holds this invoice: put it on the bank route instead.
      await db.query("update public.payment_intents set payout_route = 'bank' where org_id = $1 and source_id = $2", [orgId, invoiceId]);
    });
    await applyMigrations(db, (file) => file.startsWith("0045_") || file.startsWith("0047_") || file.startsWith("0124_"));
    const def = await definition("payment_intents_payout_route_check");
    for (const route of ["cctp", "gateway", "escrow", "bank"]) expect(def).toContain(`'${route}'`);
  });
});

describe("bank_payouts_ready (0124)", () => {
  it("answers the tenant role, and no one signed in or out", async () => {
    const orgId = await createOrg(db, "bank-ready");
    const ready = await asTenant(db, orgId, async (tx) => (await tx.query<{ ok: boolean }>("select public.bank_payouts_ready($1) as ok", [orgId])).rows[0].ok);
    expect(ready).toBe(true);
    await expect(asRole(db, "anon", (tx) => tx.query("select public.bank_payouts_ready($1)", [orgId]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "authenticated", (tx) => tx.query("select public.bank_payouts_ready($1)", [orgId]))).rejects.toThrow(/permission denied/);
  });
});
