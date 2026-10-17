import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, createUser, seedOrgRows } from "./support/pglite";

/**
 * Migration 0128 (docs/superpowers/specs/2026-10-17-term-requests-design.md X1, X4, X5): a request for more time only on a
 * held payable, one open per bill, the new due date the old one plus the days; agreed, the due date moves and the bill
 * returns to pending; a bill that changed takes nothing; the requests turned on with 3 to 30 days, by the server alone;
 * and a re-run that changes nothing.
 */

let db: PGlite;
let person: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // migrate.ts re-runs every file: a second run of 0128 keeps what is there.
  await applyMigrations(db, (file) => file.startsWith("0128_"));
  person = await createUser(db, "owner-terms@example.com");
}, 60_000);

afterAll(async () => {
  await db.close();
});

const hash = () => crypto.randomBytes(32).toString("hex");

/** A workspace with a 100 USDC bill due in 4 days, held (for want of cash), or scheduled when `status` says so. */
async function bill(tag: string, status = "held"): Promise<{ orgId: string; invoiceId: string }> {
  const orgId = await createOrg(db, tag);
  const { counterpartyId } = await seedOrgRows(db, orgId, tag);
  const invoiceId = (
    await db.query<{ id: string }>(
      `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, scheduled_for, memo)
       values ($1, 'payable', $2, 100, date_trunc('day', now()) + interval '4 days 12 hours', $3,
               case when $3 = 'scheduled' then date_trunc('day', now()) + interval '4 days' end, 'INV-130') returning id`,
      [orgId, counterpartyId, status]
    )
  ).rows[0].id;
  return { orgId, invoiceId };
}

const request = (orgId: string, invoiceId: string, token: string, days = 7) =>
  asServiceRole(db, (tx) =>
    tx.query<{ id: string; days: number; due_date: string; new_due_date: string; status: string }>("select * from public.create_term_request($1, $2, $3, $4, now() + interval '5 days')", [orgId, invoiceId, days, token])
  );
const decide = (token: string, accept: boolean) =>
  asServiceRole(db, (tx) => tx.query<{ outcome: string; days: number | null }>("select * from public.decide_term_request($1, $2)", [token, accept]));
const invoice = async (id: string) =>
  (await db.query<{ status: string; due_date: string; amount: string }>("select status, due_date, amount from public.invoices where id = $1", [id])).rows[0];

describe("asking for more time (X4)", () => {
  it("takes a held bill only, sets the new due date, and keeps one request open per bill", async () => {
    const { orgId, invoiceId } = await bill("terms-make");
    const due = (await invoice(invoiceId)).due_date;
    const first = (await request(orgId, invoiceId, hash())).rows[0];
    expect(first.status).toBe("open");
    expect(Date.parse(first.new_due_date) - Date.parse(due)).toBe(7 * 86_400_000);
    await request(orgId, invoiceId, hash(), 10);
    const rows = (await db.query<{ status: string; days: number }>("select status, days from public.payment_term_requests where invoice_id = $1 order by created_at", [invoiceId])).rows;
    expect(rows.map((row) => row.status)).toEqual(["withdrawn", "open"]);
    expect(rows[1].days).toBe(10);

    const scheduled = await bill("terms-scheduled", "scheduled");
    await expect(request(scheduled.orgId, scheduled.invoiceId, hash())).rejects.toThrow(/term_request_not_eligible/);
  });

  it("is the server's alone to make", async () => {
    const { orgId, invoiceId } = await bill("terms-roles");
    await expect(asTenant(db, orgId, (tx) => tx.query("select * from public.create_term_request($1, $2, 7, $3, now() + interval '5 days')", [orgId, invoiceId, hash()]))).rejects.toThrow(/permission denied/);
  });
});

describe("the supplier's answer (X5)", () => {
  it("agreed, moves the due date and returns the bill to pending, once", async () => {
    const { orgId, invoiceId } = await bill("terms-agree");
    const token = hash();
    const made = (await request(orgId, invoiceId, token, 14)).rows[0];
    expect((await asServiceRole(db, (tx) => tx.query<{ days: number }>("select * from public.term_request_preview($1)", [token]))).rows[0]).toMatchObject({ days: 14 });
    expect((await decide(token, true)).rows[0]).toMatchObject({ outcome: "accepted", days: 14 });
    const after = await invoice(invoiceId);
    expect(after.status).toBe("pending");
    expect(new Date(after.due_date).toISOString()).toBe(new Date(made.new_due_date).toISOString());
    expect((await decide(token, true)).rows[0].outcome).toBe("not_valid");
    expect((await asServiceRole(db, (tx) => tx.query("select * from public.term_request_preview($1)", [token]))).rows).toHaveLength(0);
  });

  it("declined, or the bill changed, leaves the bill as it was", async () => {
    const declined = await bill("terms-decline");
    const declinedToken = hash();
    await request(declined.orgId, declined.invoiceId, declinedToken);
    const before = await invoice(declined.invoiceId);
    expect((await decide(declinedToken, false)).rows[0].outcome).toBe("declined");
    expect(await invoice(declined.invoiceId)).toEqual(before);

    const changed = await bill("terms-changed");
    const changedToken = hash();
    await request(changed.orgId, changed.invoiceId, changedToken);
    await db.query("update public.invoices set amount = 120 where id = $1", [changed.invoiceId]);
    expect((await decide(changedToken, true)).rows[0].outcome).toBe("bill_changed");
    expect((await invoice(changed.invoiceId)).status).toBe("held");
  });
});

describe("turning the requests on and off (X1)", () => {
  const setting = (orgId: string, on: boolean, days: number | null) => asServiceRole(db, (tx) => tx.query("select public.set_term_requests($1, $2, $3, $4)", [orgId, on, days, person]));

  it("keeps when, by whom and the most days, from 3 to 30, and only the server sets it", async () => {
    const orgId = await createOrg(db, "terms-setting");
    await setting(orgId, true, 14);
    expect((await db.query("select term_requests_on_by, term_requests_max_days, term_requests_on_at is not null as on from public.orgs where id = $1", [orgId])).rows[0]).toEqual({ term_requests_on_by: person, term_requests_max_days: 14, on: true });
    await setting(orgId, false, null);
    expect((await db.query("select term_requests_on_at, term_requests_max_days from public.orgs where id = $1", [orgId])).rows[0]).toEqual({ term_requests_on_at: null, term_requests_max_days: 14 });
    await expect(setting(orgId, true, 2)).rejects.toThrow(/term_requests_max_days/);
    await expect(setting(orgId, true, 31)).rejects.toThrow(/term_requests_max_days/);
    await expect(asTenant(db, orgId, (tx) => tx.query("select public.set_term_requests($1, true, 14, $2)", [orgId, person]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "anon", (tx) => tx.query("select public.set_term_requests($1, true, 14, $2)", [orgId, person]))).rejects.toThrow(/permission denied/);
    const ready = await asTenant(db, orgId, (tx) => tx.query<{ ready: boolean }>("select public.term_requests_ready($1) as ready", [orgId]));
    expect(ready.rows[0].ready).toBe(true);
  });
});
