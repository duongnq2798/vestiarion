import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0058 (docs/superpowers/specs/2026-10-02-x402-payee-history-design.md R1, §4): payee_history counts
 * only confirmed live payments, across workspaces, with no amounts and no workspace; only the service role
 * may call it; x402_sales is the platform's alone; service_purchases keeps its statuses to three.
 */

let db: PGlite;
const ADDRESS = "0x537409Db5D90c0b1F4A8d0B087c8427A7C955981";

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function paid(orgId: string, destination: string, status = "confirmed", mode = "live", at = "2026-10-01T10:00:00Z") {
  await db.query(
    `insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, provider_mode, amount, destination, status, confirmed_at)
     values ($1, 'milestone', gen_random_uuid(), gen_random_uuid()::text, 'circle', $2, 1, $3, $4, $5)`,
    [orgId, mode, destination, status, status === "confirmed" ? at : null]
  );
}

describe("payee_history (0058)", () => {
  it("counts confirmed live payments to the address across workspaces, case aside, and nothing else", async () => {
    const one = await createOrg(db, "history-one");
    const two = await createOrg(db, "history-two");
    await paid(one, ADDRESS, "confirmed", "live", "2026-09-29T10:00:00Z");
    await paid(one, ADDRESS.toLowerCase(), "confirmed", "live", "2026-10-02T06:28:15Z");
    await paid(two, ADDRESS, "confirmed", "live", "2026-10-01T10:00:00Z");
    await paid(two, ADDRESS, "pending");
    await paid(two, ADDRESS, "confirmed", "simulate");
    await paid(two, "0x1111111111111111111111111111111111111111");

    const answer = (await db.query<{ h: Record<string, unknown> }>("select public.payee_history($1) as h", [ADDRESS])).rows[0].h;
    expect(answer).toMatchObject({ workspacesPaid: 2, paymentsConfirmed: 3 });
    expect(new Date(String(answer.firstPaidAt)).toISOString()).toBe("2026-09-29T10:00:00.000Z");
    expect(new Date(String(answer.lastPaidAt)).toISOString()).toBe("2026-10-02T06:28:15.000Z");
    expect(Object.keys(answer).sort()).toEqual(["firstPaidAt", "lastPaidAt", "paymentsConfirmed", "workspacesPaid"]);
  });

  it("answers zero for an address no workspace paid", async () => {
    const answer = (await db.query<{ h: Record<string, unknown> }>("select public.payee_history($1) as h", ["0x9999999999999999999999999999999999999999"])).rows[0].h;
    expect(answer).toMatchObject({ workspacesPaid: 0, paymentsConfirmed: 0, firstPaidAt: null, lastPaidAt: null });
  });

  it("is the service role's alone: a workspace or a browser cannot read other workspaces through it", async () => {
    const org = await createOrg(db, "history-tenant");
    await expect(asTenant(db, org, (tx) => tx.query("select public.payee_history($1)", [ADDRESS]))).rejects.toThrow(/permission denied/);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.payee_history($1)", [ADDRESS]))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("x402_sales (0058)", () => {
  it("is the platform's alone, and records one sale per authorization", async () => {
    const org = await createOrg(db, "sales-tenant");
    await expect(asTenant(db, org, (tx) => tx.query("select * from public.x402_sales"))).rejects.toThrow(/permission denied/);
    const sale = `insert into public.x402_sales (endpoint, address, payer, pay_to, amount_usdc, nonce) values ('/api/x402/payee-history', $1, '0xab', '0xcd', 0.001, 'nonce-1')`;
    await db.query(sale, [ADDRESS]);
    await expect(db.query(sale, [ADDRESS])).rejects.toThrow(/x402_sales_nonce_key/);
  });
});

describe("service_purchases (0058)", () => {
  it("keeps a purchase paid, refused or failed", async () => {
    const org = await createOrg(db, "purchases-status");
    const cp = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Puka', 'vendor') returning id", [org])).rows[0].id;
    const insert = (status: string) =>
      db.query("insert into public.service_purchases (org_id, counterparty_id, address, seller_url, status) values ($1, $2, $3, 'https://www.vestiarion.xyz/api/x402/payee-history', $4)", [org, cp, ADDRESS, status]);
    await insert("paid");
    await insert("refused");
    await expect(insert("pending")).rejects.toThrow(/service_purchases_status_check/);
  });
});
