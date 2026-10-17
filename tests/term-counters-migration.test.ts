import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg, seedOrgRows } from "./support/pglite";

/**
 * Migration 0130 (docs/superpowers/specs/2026-10-17-term-requests-follow-up-design.md F5, F6): a supplier counters an open
 * request with fewer days, once, from 1 to fewer than asked; the agent answers it; accepted, the bill's due date moves by
 * the counter's days and it returns to pending, unless the bill changed; declined, nothing moves; the server alone does
 * either; and a re-run that keeps what is there.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // migrate.ts re-runs every file: a second run of 0128 and 0130 keeps what is there.
  await applyMigrations(db, (file) => file.startsWith("0128_") || file.startsWith("0130_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

const hash = () => crypto.randomBytes(32).toString("hex");

/** A workspace with a 100 USDC bill due in 4 days, held, and a request for 14 more days on it. */
async function asked(tag: string): Promise<{ orgId: string; invoiceId: string; requestId: string; token: string; due: string }> {
  const orgId = await createOrg(db, tag);
  const { counterpartyId } = await seedOrgRows(db, orgId, tag);
  const invoiceId = (
    await db.query<{ id: string }>(
      `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, memo)
       values ($1, 'payable', $2, 100, date_trunc('day', now()) + interval '4 days 12 hours', 'held', 'INV-131') returning id`,
      [orgId, counterpartyId]
    )
  ).rows[0].id;
  const token = hash();
  const made = await asServiceRole(db, (tx) =>
    tx.query<{ id: string; due_date: string }>("select * from public.create_term_request($1, $2, 14, $3, now() + interval '5 days')", [orgId, invoiceId, token])
  );
  return { orgId, invoiceId, requestId: made.rows[0].id, token, due: made.rows[0].due_date };
}

const counter = (token: string, days: number) =>
  asServiceRole(db, (tx) => tx.query<{ outcome: string; counter_days: number | null; days: number | null }>("select * from public.counter_term_request($1, $2)", [token, days]));
const answer = (orgId: string, requestId: string, accept: boolean) =>
  asServiceRole(db, (tx) => tx.query<{ outcome: string; counter_days: number | null; new_due_date: string | null }>("select * from public.answer_term_counter($1, $2, $3)", [orgId, requestId, accept]));
const requestRow = async (id: string) =>
  (await db.query<{ status: string; days: number; counter_days: number | null; new_due_date: string }>("select status, days, counter_days, new_due_date from public.payment_term_requests where id = $1", [id])).rows[0];
const invoice = async (id: string) => (await db.query<{ status: string; due_date: string }>("select status, due_date from public.invoices where id = $1", [id])).rows[0];

describe("the supplier's counter (F5)", () => {
  it("takes fewer days than asked, once, and the link works no more", async () => {
    const { requestId, token } = await asked("counter-make");
    expect((await counter(token, 7)).rows[0]).toMatchObject({ outcome: "countered", counter_days: 7, days: 14 });
    expect(await requestRow(requestId)).toMatchObject({ status: "countered", counter_days: 7, days: 14 });
    expect((await counter(token, 5)).rows[0].outcome).toBe("not_valid");
  });

  it("refuses no days, or as many days as asked or more, and changes nothing", async () => {
    const { requestId, token } = await asked("counter-bad");
    expect((await counter(token, 0)).rows[0].outcome).toBe("bad_days");
    expect((await counter(token, 14)).rows[0].outcome).toBe("bad_days");
    expect((await counter(token, 20)).rows[0].outcome).toBe("bad_days");
    expect((await requestRow(requestId)).status).toBe("open");
  });
});

describe("the agent's answer (F6)", () => {
  it("accepted, moves the due date by the counter's days and returns the bill to pending, once", async () => {
    const { orgId, invoiceId, requestId, token, due } = await asked("counter-accept");
    await counter(token, 7);
    const done = (await answer(orgId, requestId, true)).rows[0];
    expect(done.outcome).toBe("accepted");
    expect(Date.parse(done.new_due_date as string) - Date.parse(due)).toBe(7 * 86_400_000);
    const bill = await invoice(invoiceId);
    expect(bill.status).toBe("pending");
    expect(Date.parse(bill.due_date)).toBe(Date.parse(done.new_due_date as string));
    expect(await requestRow(requestId)).toMatchObject({ status: "accepted", days: 7 });
    expect((await answer(orgId, requestId, true)).rows[0].outcome).toBe("not_countered");
  });

  it("declined, moves nothing", async () => {
    const { orgId, invoiceId, requestId, token, due } = await asked("counter-decline");
    await counter(token, 5);
    expect((await answer(orgId, requestId, false)).rows[0].outcome).toBe("declined");
    const bill = await invoice(invoiceId);
    expect(bill.status).toBe("held");
    expect(Date.parse(bill.due_date)).toBe(Date.parse(due));
    expect((await requestRow(requestId)).status).toBe("declined");
  });

  it("takes nothing on a bill that changed, or was paid for, since the request", async () => {
    const changed = await asked("counter-changed");
    await counter(changed.token, 7);
    await db.query("update public.invoices set amount = 120 where id = $1", [changed.invoiceId]);
    expect((await answer(changed.orgId, changed.requestId, true)).rows[0].outcome).toBe("bill_changed");
    expect((await requestRow(changed.requestId)).status).toBe("declined");

    const paid = await asked("counter-paid");
    await counter(paid.token, 7);
    await db.query(
      `insert into public.payment_intents (org_id, source_type, source_id, idempotency_key, provider, amount, destination)
       values ($1, 'invoice', $2, $3, 'simulate', 100, 'sim:x')`,
      [paid.orgId, paid.invoiceId, `k-${paid.invoiceId}`]
    );
    expect((await answer(paid.orgId, paid.requestId, true)).rows[0].outcome).toBe("bill_changed");
    expect(Date.parse((await invoice(paid.invoiceId)).due_date)).toBe(Date.parse(paid.due));
  });

  it("answers only the request's own workspace", async () => {
    const mine = await asked("counter-mine");
    const theirs = await asked("counter-theirs");
    await counter(mine.token, 7);
    expect((await answer(theirs.orgId, mine.requestId, true)).rows[0].outcome).toBe("not_countered");
  });
});

describe("who reaches counters", () => {
  it("is done by the server alone", async () => {
    const { orgId, requestId } = await asked("counter-who");
    await expect(asTenant(db, orgId, (tx) => tx.query("select * from public.answer_term_counter($1, $2, true)", [orgId, requestId]))).rejects.toThrow(/permission denied/);
    await expect(asRole(db, "anon", (tx) => tx.query("select * from public.counter_term_request($1, 3)", [hash()]))).rejects.toThrow(/permission denied/);
  });
});
