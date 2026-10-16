import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asServiceRole, asTenant, createDatabase, createOrg, createUser, seedOrgRows } from "./support/pglite";

/**
 * Migration 0127 (docs/superpowers/specs/2026-10-17-offer-counters-design.md N1, N2, N5): a supplier counters only the
 * agent's own open offer, with a smaller discount; the agent's answer is made once; an accepted counter puts its discount
 * on the bill, ending today, and a re-run of 0125-0127 keeps 'countered' in the status check.
 */

let db: PGlite;
let person: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // migrate.ts re-runs every file: 0125 and 0126 again, then 0127, must leave 'countered' allowed.
  await applyMigrations(db, (file) => file.startsWith("0125_") || file.startsWith("0126_") || file.startsWith("0127_"));
  person = await createUser(db, "owner-counters@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const hash = () => crypto.randomBytes(32).toString("hex");

/** A workspace's 100 USDC bill scheduled 20 days out, with an open 0.50% offer, the agent's when `byAgent`. */
async function offered(tag: string, byAgent: boolean): Promise<{ orgId: string; invoiceId: string; offerId: string; token: string }> {
  const orgId = await createOrg(db, tag);
  const { counterpartyId } = await seedOrgRows(db, orgId, tag);
  const invoiceId = (
    await db.query<{ id: string }>(
      `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, scheduled_for, memo)
       values ($1, 'payable', $2, 100, now() + interval '20 days', 'scheduled', now() + interval '20 days', 'INV-121') returning id`,
      [orgId, counterpartyId]
    )
  ).rows[0].id;
  const token = hash();
  const offerId = (
    await asServiceRole(db, (tx) =>
      tx.query<{ id: string }>("select id from public.create_early_payment_offer($1, $2, 0.5, $3, $4, now() + interval '7 days')", [orgId, invoiceId, token, byAgent ? null : person])
    )
  ).rows[0].id;
  if (byAgent) await db.query("insert into public.early_payment_offer_reviews (org_id, invoice_id, action, discount_pct, offer_id, emailed_at) values ($1, $2, 'offer', 0.5, $3, now())", [orgId, invoiceId, offerId]);
  return { orgId, invoiceId, offerId, token };
}

const counter = (token: string, pct: number) =>
  asServiceRole(db, (tx) => tx.query<{ outcome: string; counter_pct: string | null }>("select * from public.counter_early_payment_offer($1, $2)", [token, pct]));
const answer = (orgId: string, offerId: string, accept: boolean) =>
  asServiceRole(db, (tx) => tx.query<{ outcome: string; offered_amount: string | null }>("select * from public.answer_early_payment_counter($1, $2, $3)", [orgId, offerId, accept]));
const byAgent = (token: string) => asServiceRole(db, (tx) => tx.query<{ by: boolean }>("select public.early_payment_offer_by_agent($1) as by", [token]));

describe("a supplier's counter (N1, N2)", () => {
  it("is taken on the agent's open offer only, below its discount, and ends the link", async () => {
    const agent = await offered("counter-agent", true);
    expect((await byAgent(agent.token)).rows[0].by).toBe(true);
    expect((await counter(agent.token, 0.5)).rows[0].outcome).toBe("bad_pct");
    expect((await counter(agent.token, 0.05)).rows[0].outcome).toBe("bad_pct");
    expect((await counter(agent.token, 0.25)).rows[0]).toMatchObject({ outcome: "countered", counter_pct: "0.25" });
    const row = (await db.query<{ status: string; counter_pct: string; decided_at: string | null }>("select status, counter_pct, decided_at from public.early_payment_offers where id = $1", [agent.offerId])).rows[0];
    expect(row).toMatchObject({ status: "countered", counter_pct: "0.25" });
    expect(row.decided_at).not.toBeNull();
    // The link works no more: no second counter, no acceptance of the original.
    expect((await counter(agent.token, 0.2)).rows[0].outcome).toBe("not_valid");
    expect((await asServiceRole(db, (tx) => tx.query<{ outcome: string }>("select * from public.decide_early_payment_offer($1, true)", [agent.token]))).rows[0].outcome).toBe("not_valid");

    const personal = await offered("counter-person", false);
    expect((await byAgent(personal.token)).rows[0].by).toBe(false);
    expect((await counter(personal.token, 0.25)).rows[0].outcome).toBe("not_agent");
  });

  it("is the server's alone to take or answer", async () => {
    const agent = await offered("counter-roles", true);
    await expect(asTenant(db, agent.orgId, (tx) => tx.query("select * from public.counter_early_payment_offer($1, 0.25)", [agent.token]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, agent.orgId, (tx) => tx.query("select * from public.answer_early_payment_counter($1, $2, true)", [agent.orgId, agent.offerId]))).rejects.toThrow(/permission denied/);
  });
});

describe("the agent's answer (N5)", () => {
  it("accepted, puts the counter on the bill, ending today, returns it to pending, and is made once", async () => {
    const agent = await offered("answer-accept", true);
    await counter(agent.token, 0.25);
    expect((await answer(agent.orgId, agent.offerId, true)).rows[0]).toMatchObject({ outcome: "accepted", offered_amount: "99.750000" });
    const bill = (await db.query<{ status: string; early_pay_discount_pct: string; scheduled_for: string | null; today: boolean }>(
      "select status, early_pay_discount_pct, scheduled_for, (discount_due_date at time zone 'UTC')::date = (now() at time zone 'UTC')::date as today from public.invoices where id = $1",
      [agent.invoiceId]
    )).rows[0];
    expect(bill).toMatchObject({ status: "pending", early_pay_discount_pct: "0.25", scheduled_for: null, today: true });
    const offer = (await db.query<{ status: string; discount_pct: string; offered_amount: string }>("select status, discount_pct, offered_amount from public.early_payment_offers where id = $1", [agent.offerId])).rows[0];
    expect(offer).toEqual({ status: "accepted", discount_pct: "0.25", offered_amount: "99.750000" });
    expect((await answer(agent.orgId, agent.offerId, false)).rows[0].outcome).toBe("not_countered");
  });

  it("declined, or the bill changed, leaves the bill as it was and the offer declined", async () => {
    const declined = await offered("answer-decline", true);
    await counter(declined.token, 0.25);
    expect((await answer(declined.orgId, declined.offerId, false)).rows[0].outcome).toBe("declined");
    expect((await db.query<{ status: string; early_pay_discount_pct: string | null }>("select status, early_pay_discount_pct from public.invoices where id = $1", [declined.invoiceId])).rows[0]).toEqual({ status: "scheduled", early_pay_discount_pct: null });

    const changed = await offered("answer-changed", true);
    await counter(changed.token, 0.25);
    await db.query("update public.invoices set amount = 120 where id = $1", [changed.invoiceId]);
    expect((await answer(changed.orgId, changed.offerId, true)).rows[0].outcome).toBe("bill_changed");
    expect((await db.query<{ status: string }>("select status from public.early_payment_offers where id = $1", [changed.offerId])).rows[0].status).toBe("declined");
    expect((await db.query<{ early_pay_discount_pct: string | null }>("select early_pay_discount_pct from public.invoices where id = $1", [changed.invoiceId])).rows[0].early_pay_discount_pct).toBeNull();
  });
});
