import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, seedOrgRows } from "./support/pglite";

/**
 * Migration 0129 (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md C1, C2, C4-C6): an offer only
 * for an open USDC receivable nothing was applied to, due 7 days or more out, one open per receivable, read by its
 * workspace alone; the customer's preview and decision by token; an accepted offer puts the discount on the receivable,
 * ending on its pay-by day, and a receivable that changed takes none of it; a paid one is marked so once settled.
 */

let db: PGlite;
let person: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  await applyMigrations(db, (file) => file.startsWith("0129_"));
  person = await createUser(db, "owner-discounts@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const hash = () => crypto.randomBytes(32).toString("hex");
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
/** A date column as the day it names: PGlite reads one as a Date, PostgREST as "YYYY-MM-DD". */
const asDay = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);

/** A workspace with an open 200 USDC receivable due 30 days from now. */
async function receivable(tag: string): Promise<{ orgId: string; invoiceId: string; counterpartyId: string }> {
  const orgId = await createOrg(db, tag);
  const { counterpartyId } = await seedOrgRows(db, orgId, tag);
  const invoiceId = (
    await db.query<{ id: string }>(
      `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, memo)
       values ($1, 'receivable', $2, 200, now() + interval '30 days', 'pending', 'INV-77') returning id`,
      [orgId, counterpartyId]
    )
  ).rows[0].id;
  return { orgId, invoiceId, counterpartyId };
}

const offer = (orgId: string, invoiceId: string, token: string, pct = 1, payBy = day(5)) =>
  asServiceRole(db, (tx) =>
    tx.query<{ id: string; offered_amount: string; expires_at: string; status: string; pay_by: string }>(
      "select * from public.create_customer_discount_offer($1, $2, $3, $4, $5::date)",
      [orgId, invoiceId, pct, token, payBy]
    )
  );

const decide = (token: string, accept: boolean) =>
  asServiceRole(db, (tx) => tx.query<{ outcome: string; discount_pct: string | null; pay_by: string | null }>("select * from public.decide_customer_discount($1, $2)", [token, accept]));

describe("turning it on (C1)", () => {
  it("sets the ceiling from 0.5% to 5%, and keeps it when turned off", async () => {
    const orgId = await createOrg(db, "discount-setting");
    await asServiceRole(db, (tx) => tx.query("select public.set_customer_offers($1, true, 2, $2)", [orgId, person]));
    const on = (await db.query<{ on_at: string | null; pct: string }>("select customer_offers_on_at as on_at, customer_offers_max_pct as pct from public.orgs where id = $1", [orgId])).rows[0];
    expect(on.on_at).not.toBeNull();
    expect(on.pct).toBe("2.00");
    await asServiceRole(db, (tx) => tx.query("select public.set_customer_offers($1, false, null, $2)", [orgId, person]));
    expect((await db.query<{ on_at: string | null; pct: string }>("select customer_offers_on_at as on_at, customer_offers_max_pct as pct from public.orgs where id = $1", [orgId])).rows[0]).toEqual({ on_at: null, pct: "2.00" });
    await expect(asServiceRole(db, (tx) => tx.query("select public.set_customer_offers($1, true, 6, $2)", [orgId, person]))).rejects.toThrow(/customer_offers_max_pct/);
  });
});

describe("making an offer (C2, C4)", () => {
  it("takes the receivable's amount and the discount, open to the end of the pay-by day, one open per receivable", async () => {
    const { orgId, invoiceId } = await receivable("discount-make");
    const first = (await offer(orgId, invoiceId, hash())).rows[0];
    expect({ ...first, pay_by: asDay(first.pay_by) }).toMatchObject({ offered_amount: "198.000000", status: "open", pay_by: day(5) });
    expect(new Date(first.expires_at).toISOString()).toBe(`${day(5)}T23:59:59.000Z`);
    await offer(orgId, invoiceId, hash(), 2);
    const rows = (await db.query<{ status: string; discount_pct: string }>("select status, discount_pct from public.customer_discount_offers where invoice_id = $1 order by created_at", [invoiceId])).rows;
    expect(rows.map((row) => row.status)).toEqual(["withdrawn", "open"]);
    expect(rows[1].discount_pct).toBe("2.00");
  });

  it("refuses a payable, a discounted receivable, one due within 7 days, one with money applied or matched, or EURC", async () => {
    const payable = await receivable("discount-payable");
    await db.query("update public.invoices set direction = 'payable' where id = $1", [payable.invoiceId]);
    await expect(offer(payable.orgId, payable.invoiceId, hash())).rejects.toThrow(/discount_not_eligible/);

    const discounted = await receivable("discount-discounted");
    await db.query("update public.invoices set early_pay_discount_pct = 1, discount_due_date = now() + interval '3 days' where id = $1", [discounted.invoiceId]);
    await expect(offer(discounted.orgId, discounted.invoiceId, hash())).rejects.toThrow(/discount_not_eligible/);

    const soon = await receivable("discount-soon");
    await db.query("update public.invoices set due_date = now() + interval '5 days' where id = $1", [soon.invoiceId]);
    await expect(offer(soon.orgId, soon.invoiceId, hash())).rejects.toThrow(/discount_not_eligible/);

    const matched = await receivable("discount-matched");
    await db.query(
      `insert into public.incoming_transfers (org_id, circle_tx_id, tx_hash, amount, token, chain, received_at, invoice_id, matched_by)
       values ($1, 'circle-m', '0xm', 50, 'USDC', 'ARC-TESTNET', now(), $2, 'person')`,
      [matched.orgId, matched.invoiceId]
    );
    await expect(offer(matched.orgId, matched.invoiceId, hash())).rejects.toThrow(/discount_not_eligible/);

    const eurc = await receivable("discount-eurc");
    await db.query("update public.invoices set currency = 'EURC' where id = $1", [eurc.invoiceId]);
    await expect(offer(eurc.orgId, eurc.invoiceId, hash())).rejects.toThrow(/discount_not_eligible/);
  });

  it("refuses a pay-by day in the past or on or after the due date", async () => {
    const { orgId, invoiceId } = await receivable("discount-payby");
    await expect(offer(orgId, invoiceId, hash(), 1, day(-1))).rejects.toThrow(/discount_pay_by/);
    await expect(offer(orgId, invoiceId, hash(), 1, day(31))).rejects.toThrow(/discount_pay_by/);
  });
});

describe("the customer's decision (C4, C5)", () => {
  it("previews an open offer, and nothing for any other token", async () => {
    const { orgId, invoiceId } = await receivable("discount-preview");
    const token = hash();
    await offer(orgId, invoiceId, token);
    const seen = (await asServiceRole(db, (tx) => tx.query<{ memo: string; offered_amount: string; pay_by: string }>("select * from public.customer_discount_preview($1)", [token]))).rows;
    expect(seen.map((row) => ({ ...row, pay_by: asDay(row.pay_by) }))).toEqual([expect.objectContaining({ memo: "INV-77", offered_amount: "198.000000", pay_by: day(5) })]);
    expect((await asServiceRole(db, (tx) => tx.query("select * from public.customer_discount_preview($1)", [hash()]))).rows).toEqual([]);
  });

  it("puts the discount on the receivable, ending on the pay-by day, once, and leaves its amount", async () => {
    const { orgId, invoiceId } = await receivable("discount-accept");
    const token = hash();
    await offer(orgId, invoiceId, token, 1.5);
    const accepted = (await decide(token, true)).rows[0];
    expect({ ...accepted, pay_by: asDay(accepted.pay_by) }).toMatchObject({ outcome: "accepted", discount_pct: "1.50", pay_by: day(5) });
    const row = (
      await db.query<{ amount: string; status: string; pct: string; until: string }>(
        `select amount, status, early_pay_discount_pct as pct, to_char((discount_due_date at time zone 'UTC')::date, 'YYYY-MM-DD') as until
           from public.invoices where id = $1`,
        [invoiceId]
      )
    ).rows[0];
    expect(row).toEqual({ amount: "200.000000", status: "pending", pct: "1.50", until: day(5) });
    expect((await decide(token, true)).rows[0].outcome).toBe("not_valid");
  });

  it("changes nothing on a receivable whose amount changed, or that money was matched to, since the offer", async () => {
    const changed = await receivable("discount-changed");
    const token = hash();
    await offer(changed.orgId, changed.invoiceId, token);
    await db.query("update public.invoices set amount = 250 where id = $1", [changed.invoiceId]);
    expect((await decide(token, true)).rows[0].outcome).toBe("changed");
    expect((await db.query<{ pct: string | null }>("select early_pay_discount_pct as pct from public.invoices where id = $1", [changed.invoiceId])).rows[0].pct).toBeNull();

    const paid = await receivable("discount-paid-first");
    const other = hash();
    await offer(paid.orgId, paid.invoiceId, other);
    await db.query(
      `insert into public.incoming_transfers (org_id, circle_tx_id, tx_hash, amount, token, chain, received_at, invoice_id, matched_by)
       values ($1, 'circle-p', '0xp', 200, 'USDC', 'ARC-TESTNET', now(), $2, 'sender')`,
      [paid.orgId, paid.invoiceId]
    );
    expect((await decide(other, true)).rows[0].outcome).toBe("changed");
  });

  it("declines without touching the receivable, and a withdrawn offer is no longer valid", async () => {
    const declined = await receivable("discount-decline");
    const token = hash();
    await offer(declined.orgId, declined.invoiceId, token);
    expect((await decide(token, false)).rows[0].outcome).toBe("declined");
    expect((await db.query<{ pct: string | null }>("select early_pay_discount_pct as pct from public.invoices where id = $1", [declined.invoiceId])).rows[0].pct).toBeNull();

    const withdrawn = await receivable("discount-withdraw");
    const other = hash();
    const row = (await offer(withdrawn.orgId, withdrawn.invoiceId, other)).rows[0];
    const done = await asServiceRole(db, (tx) => tx.query<{ ok: boolean }>("select public.withdraw_customer_discount_offer($1, $2) as ok", [withdrawn.orgId, row.id]));
    expect(done.rows[0].ok).toBe(true);
    expect((await decide(other, true)).rows[0].outcome).toBe("not_valid");
  });
});

describe("paid at the discount (C6)", () => {
  it("marks an accepted offer paid only once its receivable is received", async () => {
    const { orgId, invoiceId } = await receivable("discount-settle");
    const token = hash();
    const made = (await offer(orgId, invoiceId, token)).rows[0];
    await decide(token, true);
    const settle = () => asServiceRole(db, (tx) => tx.query<{ id: string | null }>("select public.settle_customer_discount($1, $2) as id", [orgId, invoiceId]));
    expect((await settle()).rows[0].id).toBeNull();
    await db.query("update public.invoices set status = 'received', settled_at = now() where id = $1", [invoiceId]);
    expect((await settle()).rows[0].id).toBe(made.id);
    expect((await db.query<{ status: string; paid: boolean }>("select status, paid_at is not null as paid from public.customer_discount_offers where id = $1", [made.id])).rows[0]).toEqual({ status: "paid", paid: true });
    expect((await settle()).rows[0].id).toBeNull();
  });
});

describe("who reaches offers (C1, C4)", () => {
  it("is read by its own workspace only, written by no tenant request, and its functions answer the service role", async () => {
    const mine = await receivable("discount-mine");
    const theirs = await receivable("discount-theirs");
    await offer(mine.orgId, mine.invoiceId, hash());
    await offer(theirs.orgId, theirs.invoiceId, hash());
    const seen = await asTenant(db, mine.orgId, async (tx) => (await tx.query<{ org_id: string }>("select org_id from public.customer_discount_offers")).rows);
    expect([...new Set(seen.map((row) => row.org_id))]).toEqual([mine.orgId]);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("update public.customer_discount_offers set status = 'withdrawn'"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("select * from public.customer_discount_preview($1)", [hash()]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine.orgId, (tx) => tx.query("select public.set_customer_offers($1, true, 1, null)", [mine.orgId]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "anon", (tx) => tx.query("select * from public.decide_customer_discount($1, true)", [hash()]))).rejects.toThrow(/permission denied/);
    const ready = await asTenant(db, mine.orgId, async (tx) => (await tx.query<{ ok: boolean }>("select public.customer_discounts_ready($1) as ok", [mine.orgId])).rows[0].ok);
    expect(ready).toBe(true);
  });
});
