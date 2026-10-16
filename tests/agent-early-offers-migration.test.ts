import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, seedOrgRows } from "./support/pglite";

/**
 * Migration 0126 (docs/superpowers/specs/2026-10-16-agent-early-payment-offers-design.md AO1, AO4): the agent's offers
 * turned on with a ceiling from 0.5% to 10%, or off, by the server alone; one review per bill, read and written by its
 * workspace alone; and a re-run that changes nothing.
 */

let db: PGlite;
let person: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // migrate.ts re-runs every file: a second run of 0125 and 0126 keeps what is there.
  await applyMigrations(db, (file) => file.startsWith("0125_") || file.startsWith("0126_"));
  person = await createUser(db, "owner-agent-offers@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const setting = (orgId: string, on: boolean, maxPct: number | null) =>
  asServiceRole(db, (tx) => tx.query<{ set_agent_early_offers: boolean }>("select public.set_agent_early_offers($1, $2, $3, $4)", [orgId, on, maxPct, person]));
const read = async (orgId: string) =>
  (await db.query<{ early_offers_on_at: string | null; early_offers_on_by: string | null; early_offers_max_pct: string | null }>("select early_offers_on_at, early_offers_on_by, early_offers_max_pct from public.orgs where id = $1", [orgId])).rows[0];

describe("turning the agent's offers on and off (AO1)", () => {
  it("keeps when and by whom, and the ceiling; off clears who and when, and keeps the ceiling for next time", async () => {
    const orgId = await createOrg(db, "agent-offers-on");
    expect((await setting(orgId, true, 2.5)).rows[0].set_agent_early_offers).toBe(true);
    const on = await read(orgId);
    expect(on).toMatchObject({ early_offers_on_by: person, early_offers_max_pct: "2.50" });
    expect(on.early_offers_on_at).not.toBeNull();
    await setting(orgId, false, null);
    expect(await read(orgId)).toMatchObject({ early_offers_on_at: null, early_offers_on_by: null, early_offers_max_pct: "2.50" });
  });

  it("refuses a ceiling outside 0.5% to 10%, and only the server may set it", async () => {
    const orgId = await createOrg(db, "agent-offers-ceiling");
    await expect(setting(orgId, true, 0.25)).rejects.toThrow(/early_offers_max_pct/);
    await expect(setting(orgId, true, 12)).rejects.toThrow(/early_offers_max_pct/);
    await expect(setting(orgId, true, null)).rejects.toThrow(/early_offers_max_pct/);
    await expect(asTenant(db, orgId, (tx) => tx.query("select public.set_agent_early_offers($1, true, 2, $2)", [orgId, person]))).rejects.toThrow(/permission denied/);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.set_agent_early_offers($1, true, 2, $2)", [orgId, person]))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("the agent's reviews (AO4)", () => {
  it("hold one per bill, written by the bill's workspace and no other", async () => {
    const orgId = await createOrg(db, "agent-offers-review");
    const other = await createOrg(db, "agent-offers-other");
    const { invoiceId } = await seedOrgRows(db, orgId, "agent-offers-review");
    // seedOrgRows already reviewed its bill once: a second review of it is refused.
    await expect(asTenant(db, orgId, (tx) => tx.query("insert into public.early_payment_offer_reviews (org_id, invoice_id, action) values ($1, $2, 'offer')", [orgId, invoiceId]))).rejects.toThrow(/early_payment_offer_reviews_one/);
    await expect(asTenant(db, other, (tx) => tx.query("insert into public.early_payment_offer_reviews (org_id, invoice_id, action) values ($1, $2, 'skip')", [orgId, invoiceId]))).rejects.toThrow();
    const seen = await asTenant(db, other, (tx) => tx.query("select 1 from public.early_payment_offer_reviews where invoice_id = $1", [invoiceId]));
    expect(seen.rows).toHaveLength(0);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.early_payment_offer_reviews set action = 'nope' where invoice_id = $1", [invoiceId]))).rejects.toThrow(/early_payment_offer_reviews_action_check/);
    const ready = await asTenant(db, orgId, (tx) => tx.query<{ ready: boolean }>("select public.early_payment_offer_reviews_ready($1) as ready", [orgId]));
    expect(ready.rows[0].ready).toBe(true);
  });
});
