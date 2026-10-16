import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, seedOrgRows } from "./support/pglite";

/**
 * Migration 0125 (docs/superpowers/specs/2026-10-16-early-payment-offers-design.md E1, E3-E7): an offer only for an
 * eligible bill, one open per bill, read by its workspace alone; the supplier's preview and decision by token; an accepted
 * offer puts the discount on the bill, ending today, and returns a scheduled bill to pending, and a bill that changed takes
 * none of it.
 */

let db: PGlite;
let person: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  await applyMigrations(db, (file) => file.startsWith("0125_"));
  person = await createUser(db, "owner-offers@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const hash = () => crypto.randomBytes(32).toString("hex");

/** A workspace with a 100 USDC bill scheduled for 20 days from now, and no payment started for it. */
async function scheduledBill(tag: string): Promise<{ orgId: string; invoiceId: string }> {
  const orgId = await createOrg(db, tag);
  const { counterpartyId } = await seedOrgRows(db, orgId, tag);
  const invoiceId = (
    await db.query<{ id: string }>(
      `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, scheduled_for, memo)
       values ($1, 'payable', $2, 100, now() + interval '20 days', 'scheduled', now() + interval '20 days', 'INV-108') returning id`,
      [orgId, counterpartyId]
    )
  ).rows[0].id;
  return { orgId, invoiceId };
}

const offer = (orgId: string, invoiceId: string, token: string, pct = 1) =>
  asServiceRole(db, (tx) =>
    tx.query<{ id: string; offered_amount: string; expires_at: string; status: string }>(
      "select * from public.create_early_payment_offer($1, $2, $3, $4, $5, now() + interval '7 days')",
      [orgId, invoiceId, pct, token, person]
    )
  );

const decide = (token: string, accept: boolean) =>
  asServiceRole(db, (tx) => tx.query<{ outcome: string; discount_pct: string | null }>("select * from public.decide_early_payment_offer($1, $2)", [token, accept]));

describe("making an offer (E1, E3)", () => {
  it("takes the bill's amount and the discount, and keeps one open per bill", async () => {
    const { orgId, invoiceId } = await scheduledBill("offer-make");
    const first = (await offer(orgId, invoiceId, hash())).rows[0];
    expect(first).toMatchObject({ offered_amount: "99.000000", status: "open" });
    await offer(orgId, invoiceId, hash(), 2);
    const rows = (await db.query<{ status: string; discount_pct: string }>("select status, discount_pct from public.early_payment_offers where invoice_id = $1 order by created_at", [invoiceId])).rows;
    expect(rows.map((row) => row.status)).toEqual(["withdrawn", "open"]);
    expect(rows[1].discount_pct).toBe("2.00");
  });

  it("refuses a bill already discounted, paid for, held, due within 3 days, or a receivable", async () => {
    const discounted = await scheduledBill("offer-discounted");
    await db.query("update public.invoices set early_pay_discount_pct = 2, discount_due_date = now() + interval '5 days' where id = $1", [discounted.invoiceId]);
    await expect(offer(discounted.orgId, discounted.invoiceId, hash())).rejects.toThrow(/offer_not_eligible/);

    const started = await scheduledBill("offer-started");
    await db.query(
      `insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination)
       values ($1, 'invoice', $2, $3, 'simulate', 100, 'sim:x')`,
      [started.orgId, started.invoiceId, `k-${started.invoiceId}`]
    );
    await expect(offer(started.orgId, started.invoiceId, hash())).rejects.toThrow(/offer_not_eligible/);

    const held = await scheduledBill("offer-held");
    await db.query("update public.invoices set status = 'held' where id = $1", [held.invoiceId]);
    await expect(offer(held.orgId, held.invoiceId, hash())).rejects.toThrow(/offer_not_eligible/);

    const soon = await scheduledBill("offer-soon");
    await db.query("update public.invoices set status = 'pending', scheduled_for = null, due_date = now() + interval '1 day' where id = $1", [soon.invoiceId]);
    await expect(offer(soon.orgId, soon.invoiceId, hash())).rejects.toThrow(/offer_not_eligible/);
  });

  it("is open no later than the day before the bill falls due", async () => {
    const { orgId, invoiceId } = await scheduledBill("offer-expiry");
    await db.query("update public.invoices set due_date = now() + interval '4 days' where id = $1", [invoiceId]);
    const row = (await offer(orgId, invoiceId, hash())).rows[0];
    expect(Date.parse(row.expires_at)).toBeLessThan(Date.now() + 4 * 86_400_000);
  });
});

describe("the supplier's decision (E4-E6)", () => {
  it("previews an open offer, and nothing for any other token", async () => {
    const { orgId, invoiceId } = await scheduledBill("offer-preview");
    const token = hash();
    await offer(orgId, invoiceId, token);
    const seen = (await asServiceRole(db, (tx) => tx.query<{ memo: string; offered_amount: string; currency: string }>("select * from public.early_payment_offer_preview($1)", [token]))).rows;
    expect(seen).toEqual([expect.objectContaining({ memo: "INV-108", offered_amount: "99.000000", currency: "USDC" })]);
    expect((await asServiceRole(db, (tx) => tx.query("select * from public.early_payment_offer_preview($1)", [hash()]))).rows).toEqual([]);
  });

  it("puts the discount on the bill, ending today, and returns it to pending, once", async () => {
    const { orgId, invoiceId } = await scheduledBill("offer-accept");
    const token = hash();
    await offer(orgId, invoiceId, token, 1.5);
    expect((await decide(token, true)).rows[0]).toMatchObject({ outcome: "accepted", discount_pct: "1.50" });
    const bill = (
      await db.query<{ status: string; scheduled_for: string | null; pct: string; today: boolean }>(
        `select status, scheduled_for, early_pay_discount_pct as pct,
                (discount_due_date at time zone 'UTC')::date = (now() at time zone 'UTC')::date as today
           from public.invoices where id = $1`,
        [invoiceId]
      )
    ).rows[0];
    expect(bill).toEqual({ status: "pending", scheduled_for: null, pct: "1.50", today: true });
    expect((await decide(token, true)).rows[0].outcome).toBe("not_valid");
  });

  it("changes nothing on a bill whose amount changed, or that was paid for, since the offer", async () => {
    const { orgId, invoiceId } = await scheduledBill("offer-changed");
    const token = hash();
    await offer(orgId, invoiceId, token);
    await db.query("update public.invoices set amount = 120 where id = $1", [invoiceId]);
    expect((await decide(token, true)).rows[0].outcome).toBe("bill_changed");
    const bill = (await db.query<{ status: string; pct: string | null }>("select status, early_pay_discount_pct as pct from public.invoices where id = $1", [invoiceId])).rows[0];
    expect(bill).toEqual({ status: "scheduled", pct: null });
  });

  it("declines without touching the bill, and a withdrawn offer is no longer valid", async () => {
    const declined = await scheduledBill("offer-decline");
    const token = hash();
    await offer(declined.orgId, declined.invoiceId, token);
    expect((await decide(token, false)).rows[0].outcome).toBe("declined");
    expect((await db.query<{ status: string }>("select status from public.invoices where id = $1", [declined.invoiceId])).rows[0].status).toBe("scheduled");

    const withdrawn = await scheduledBill("offer-withdraw");
    const other = hash();
    const row = (await offer(withdrawn.orgId, withdrawn.invoiceId, other)).rows[0];
    const done = await asServiceRole(db, (tx) => tx.query<{ ok: boolean }>("select public.withdraw_early_payment_offer($1, $2, $3) as ok", [withdrawn.orgId, row.id, person]));
    expect(done.rows[0].ok).toBe(true);
    expect((await decide(other, true)).rows[0].outcome).toBe("not_valid");
  });
});

describe("who reaches offers (E7)", () => {
  it("is read by its own workspace only, written by no tenant request, and its functions answer the service role", async () => {
    const mine = await scheduledBill("offer-mine");
    const theirs = await scheduledBill("offer-theirs");
    await offer(mine.orgId, mine.invoiceId, hash());
    await offer(theirs.orgId, theirs.invoiceId, hash());
    const seen = await asTenant(db, mine.orgId, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.early_payment_offers")).rows);
    expect([...new Set(seen.map((row) => row.org_id))]).toEqual([mine.orgId]);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("update public.early_payment_offers set status = 'withdrawn'"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("select * from public.early_payment_offer_preview($1)", [hash()]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "anon", (tx) => tx.query("select * from public.decide_early_payment_offer($1, true)", [hash()]))).rejects.toThrow(/permission denied/);
    const ready = await asTenant(db, mine.orgId, async (tx) => (await tx.query<{ ok: boolean }>("select public.early_payment_offers_ready($1) as ok", [mine.orgId])).rows[0].ok);
    expect(ready).toBe(true);
  });
});
