import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0118 (docs/superpowers/specs/2026-10-14-commissions-design.md C1-C11): commission plans and their versions,
 * accruals on money applied to a receivable of a covered deal and adjustments when it is taken back, recorded once
 * however often the recording runs, and one payable per partner from what is due, which the partner never approves.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0118_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const one = async (sql: string, params: unknown[]) => (await db.query<{ id: string }>(sql, params)).rows[0].id;

/** A workspace with a customer, two partners, a deal of two released lines (300 and 700 USDC) and a receivable of no deal. */
async function workspace(slug: string) {
  const orgId = await createOrg(db, slug);
  const acme = await one("insert into public.counterparties (org_id, name, role) values ($1, 'Acme Corp', 'client') returning id", [orgId]);
  const pat = await one("insert into public.counterparties (org_id, name, role) values ($1, 'Pat Referrals', 'vendor') returning id", [orgId]);
  const sam = await one("insert into public.counterparties (org_id, name, role) values ($1, 'Sam Sales', 'contractor') returning id", [orgId]);
  const deal = await dealWith(orgId, acme, [300, 700]);
  const other = await dealWith(orgId, acme, [500]);
  const loose = await one(
    "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'receivable', $2, 400, now()) returning id",
    [orgId, acme]
  );
  return { orgId, acme, pat, sam, deal: deal.id, deposit: deal.receivables[0], balance: deal.receivables[1], otherDeal: other.id, otherReceivable: other.receivables[0], loose };
}

/** A deal for the customer, every line released as a receivable of its amount. */
async function dealWith(orgId: string, customer: string, amounts: number[]): Promise<{ id: string; receivables: string[] }> {
  const rows = amounts.map((amount, index) => ({
    position: index + 1, label: `Line ${index + 1}`, invoiceOn: "2026-10-01", dueOn: "2026-10-15", amountMinor: amount * 100, roundingMinor: 0,
  }));
  const deal = {
    counterpartyId: customer, title: `Deal ${crypto.randomUUID().slice(0, 6)}`, currency: "USDC", minorDigits: 2,
    totalMinor: amounts.reduce((total, amount) => total + amount * 100, 0), startsOn: "2026-10-01", termsDays: 14, externalRef: null,
    template: "custom", autoRelease: false, idempotencyKey: `key-${crypto.randomUUID()}`, createdBy: null, changes: [],
  };
  const id = await asTenant(db, orgId, async (tx) =>
    (await tx.query<{ r: { id: string } }>("select public.create_deal($1, $2::jsonb, $3::jsonb) as r", [orgId, JSON.stringify(deal), JSON.stringify(rows)])).rows[0].r.id
  );
  const lines = (await db.query<{ id: string; amount_minor: string }>("select id, amount_minor from public.deal_lines where deal_id = $1 order by position", [id])).rows;
  const receivables: string[] = [];
  for (const line of lines) {
    await db.query("update public.deal_lines set status = 'released', released_at = now(), released_via = 'person' where id = $1", [line.id]);
    receivables.push(
      await one(
        "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, deal_id, deal_line_id) values ($1, 'receivable', $2, $3, now(), $4, $5) returning id",
        [orgId, customer, Number(line.amount_minor) / 100, id, line.id]
      )
    );
  }
  return { id, receivables };
}

interface PlanOptions {
  rateBps?: number;
  basis?: "net" | "gross";
  deals?: string[];
  holdDays?: number;
  member?: string | null;
  replaces?: string | null;
  by?: string | null;
  reference?: string | null;
}

/** A plan set through `set_commission_plan`, starting now. */
async function setPlan(orgId: string, beneficiary: string, options: PlanOptions = {}) {
  return asTenant(db, orgId, async (tx) =>
    (
      await tx.query<{ id: string; started_at: Date; ended_at: Date | null; replaces: string | null }>(
        "select * from public.set_commission_plan($1, $2, $3, $4, $5, $6::uuid[], $7, $8, $9, $10, $11)",
        [
          orgId, beneficiary, options.rateBps ?? 1000, options.basis ?? "net", options.deals ? "chosen_deals" : "all_deals", options.deals ?? [],
          options.holdDays ?? 30, options.reference ?? null, options.member ?? null, options.replaces ?? null, options.by ?? null,
        ]
      )
    ).rows[0]
  );
}

/** A plan that started some days ago, written as the service role writes history. */
async function planSince(orgId: string, beneficiary: string, startedDaysAgo: number, options: PlanOptions = {}): Promise<string> {
  const id = await one(
    `insert into public.commission_plans (org_id, beneficiary_id, beneficiary_member, rate_bps, basis, scope, hold_days, started_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [orgId, beneficiary, options.member ?? null, options.rateBps ?? 1000, options.basis ?? "net", options.deals ? "chosen_deals" : "all_deals", options.holdDays ?? 30, daysAgo(startedDaysAgo)]
  );
  for (const deal of options.deals ?? []) await db.query("insert into public.commission_plan_deals (org_id, plan_id, deal_id) values ($1, $2, $3)", [orgId, id, deal]);
  return id;
}

let transfers = 0;
async function transfer(orgId: string, amount: number, fields: { token?: string; receivedDaysAgo?: number; invoiceId?: string } = {}) {
  transfers += 1;
  return one(
    `insert into public.incoming_transfers (org_id, circle_tx_id, tx_hash, amount, token, chain, received_at, invoice_id)
     values ($1, $2, $3, $4, $5, 'ARC-TESTNET', coalesce($6::timestamptz, now()), $7) returning id`,
    [orgId, `circle-c-${transfers}`, `0x${String(transfers).padStart(64, "0")}`, amount, fields.token ?? "USDC", fields.receivedDaysAgo ? daysAgo(fields.receivedDaysAgo) : null, fields.invoiceId ?? null]
  );
}

/** Some days ago, or now by the database's clock (so after a plan set a moment before). */
const when = (daysBack: number) => (daysBack > 0 ? daysAgo(daysBack) : null);

/** A payment applied: one row, as a person's application writes it, some days ago or now. */
async function apply(orgId: string, invoice: string, paymentId: string, amount: number, daysBack = 0): Promise<string> {
  return one(
    "insert into public.receivable_allocations (org_id, kind, invoice_id, transfer_id, amount, currency, basis, created_at) values ($1, 'payment', $2, $3, $4, 'USDC', 'person', coalesce($5::timestamptz, now())) returning id",
    [orgId, invoice, paymentId, amount, when(daysBack)]
  );
}

async function fee(orgId: string, invoice: string, amount: number, daysBack = 0): Promise<string> {
  return one(
    "insert into public.receivable_allocations (org_id, kind, invoice_id, amount, currency, reason, created_at) values ($1, 'fee', $2, $3, 'USDC', 'Lost on the way', coalesce($4::timestamptz, now())) returning id",
    [orgId, invoice, amount, when(daysBack)]
  );
}

/** A whole match as the cycle makes it (receipts R1): the transfer names the receivable, which it settles. */
async function wholeMatch(orgId: string, invoice: string, amount: number, receivedDaysAgo: number): Promise<string> {
  const paid = await transfer(orgId, amount, { receivedDaysAgo, invoiceId: invoice });
  await db.query("update public.invoices set status = 'received', settled_at = now() where id = $1", [invoice]);
  return paid;
}

async function reverse(orgId: string, allocationId: string): Promise<string> {
  const row = (await db.query<{ invoice_id: string; transfer_id: string | null; amount: string; currency: string }>("select * from public.receivable_allocations where id = $1", [allocationId])).rows[0];
  return one(
    "insert into public.receivable_allocations (org_id, kind, invoice_id, transfer_id, amount, currency, reverses, reason) values ($1, 'reversal', $2, $3, $4, $5, $6, 'Applied to the wrong invoice') returning id",
    [orgId, row.invoice_id, row.transfer_id, row.amount, row.currency, allocationId]
  );
}

interface LineRow {
  id: string;
  kind: "accrual" | "adjustment";
  plan_id: string;
  beneficiary_id: string;
  invoice_id: string;
  source: string;
  allocation_id: string | null;
  transfer_id: string | null;
  adjusts: string | null;
  base_amount: string;
  amount: string;
  applied_at: Date;
  due_at: Date;
  reason: string | null;
  payout_id: string | null;
}

const record = (orgId: string, tokenOrg: string = orgId) =>
  asTenant(db, tokenOrg, async (tx) => (await tx.query<LineRow>("select * from public.record_commissions($1)", [orgId])).rows);

const linesOf = async (orgId: string, beneficiary?: string) =>
  (
    await db.query<LineRow>(
      `select * from public.commission_lines where org_id = $1 ${beneficiary ? "and beneficiary_id = $2" : ""} order by applied_at, kind, id`,
      beneficiary ? [orgId, beneficiary] : [orgId]
    )
  ).rows;

const payout = (orgId: string, beneficiary: string, lineIds: string[], by: string | null = null, currency = "USDC") =>
  asTenant(db, orgId, async (tx) =>
    (
      await tx.query<{ r: { payoutId: string; invoiceId: string; statement: string; amount: number; lineCount: number } }>(
        "select public.create_commission_payout($1, $2, $3, $4::uuid[], $5, $6) as r",
        [orgId, beneficiary, currency, lineIds, "Commission statement: commissions on money received", by]
      )
    ).rows[0].r
  );

const invoiceOf = async (id: string) =>
  (
    await db.query<{ direction: string; counterparty_id: string; amount: string; currency: string; po_reference: string; goods_received: boolean; status: string; created_by: string | null; memo: string }>(
      "select * from public.invoices where id = $1",
      [id]
    )
  ).rows[0];

describe("record_commissions (0118): accruals", () => {
  it("accrues a part payment for exactly its part, due after the hold window", async () => {
    const w = await workspace("commission-part");
    await planSince(w.orgId, w.pat, 40, { holdDays: 30 });
    const paid = await transfer(w.orgId, 300);
    const allocation = await apply(w.orgId, w.balance, paid, 300, 35);
    const recorded = await record(w.orgId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ kind: "accrual", source: "payment", allocation_id: allocation, transfer_id: paid, invoice_id: w.balance, base_amount: "300.000000", amount: "30.000000" });
    expect(recorded[0].due_at.getTime() - recorded[0].applied_at.getTime()).toBe(30 * DAY);
    // The rest of the invoice, 400 of 700, earns its own part when it comes.
    const rest = await transfer(w.orgId, 400);
    await apply(w.orgId, w.balance, rest, 400);
    expect((await record(w.orgId)).map((line) => line.amount)).toEqual(["40.000000"]);
  });

  it("records nothing twice: a replay, a second caller and a direct second insert", async () => {
    const w = await workspace("commission-replay");
    await planSince(w.orgId, w.pat, 5, { holdDays: 0 });
    await apply(w.orgId, w.deposit, await transfer(w.orgId, 300), 300, 1);
    expect(await record(w.orgId)).toHaveLength(1);
    expect(await record(w.orgId)).toHaveLength(0);
    expect(await record(w.orgId)).toHaveLength(0);
    const [line] = await linesOf(w.orgId);
    await expect(
      db.query(
        `insert into public.commission_lines (org_id, kind, plan_id, beneficiary_id, invoice_id, deal_id, source, allocation_id, basis, base_amount, rate_bps, amount, currency, applied_at, due_at)
         select org_id, kind, plan_id, beneficiary_id, invoice_id, deal_id, source, allocation_id, basis, base_amount, rate_bps, amount, currency, applied_at, due_at from public.commission_lines where id = $1`,
        [line.id]
      )
    ).rejects.toThrow(/commission_lines_one_accrual/);
    expect(await linesOf(w.orgId)).toHaveLength(1);
  });

  it("rounds down to the millionth, and records nothing below one", async () => {
    const w = await workspace("commission-round");
    await planSince(w.orgId, w.pat, 5, { rateBps: 1250 });
    await apply(w.orgId, w.deposit, await transfer(w.orgId, 33.333333), 33.333333, 1);
    expect((await record(w.orgId))[0].amount).toBe("4.166666");
    await planSince(w.orgId, w.sam, 5, { rateBps: 1 });
    await apply(w.orgId, w.balance, await transfer(w.orgId, 0.005), 0.005, 1);
    await record(w.orgId);
    expect((await linesOf(w.orgId, w.sam)).map((line) => line.base_amount)).toEqual(["33.333333"]);
  });

  it("leaves a fee out on the net basis and counts it on the gross basis", async () => {
    const w = await workspace("commission-basis");
    await planSince(w.orgId, w.pat, 5, { basis: "net" });
    await planSince(w.orgId, w.sam, 5, { basis: "gross" });
    await apply(w.orgId, w.deposit, await transfer(w.orgId, 299.5), 299.5, 1);
    await fee(w.orgId, w.deposit, 0.5, 1);
    await record(w.orgId);
    expect((await linesOf(w.orgId, w.pat)).map((line) => [line.source, line.amount])).toEqual([["payment", "29.950000"]]);
    expect((await linesOf(w.orgId, w.sam)).map((line) => [line.source, line.amount]).sort()).toEqual([
      ["fee", "0.050000"],
      ["payment", "29.950000"],
    ]);
  });

  it("accrues a whole match on the transfer, at its arrival", async () => {
    const w = await workspace("commission-whole");
    await planSince(w.orgId, w.pat, 5, { holdDays: 7 });
    const paid = await wholeMatch(w.orgId, w.deposit, 300, 2);
    const [line] = await record(w.orgId);
    expect(line).toMatchObject({ source: "whole_match", allocation_id: null, transfer_id: paid, base_amount: "300.000000", amount: "30.000000" });
    expect(Math.abs(line.applied_at.getTime() - (Date.now() - 2 * DAY))).toBeLessThan(60_000);
    expect(line.due_at.getTime() - line.applied_at.getTime()).toBe(7 * DAY);
    expect(await record(w.orgId)).toHaveLength(0);
  });

  it("covers the chosen deals only, receivables of a deal only, and money applied from the plan's start", async () => {
    const w = await workspace("commission-scope");
    await planSince(w.orgId, w.pat, 10, { deals: [w.deal] });
    await apply(w.orgId, w.deposit, await transfer(w.orgId, 300, { receivedDaysAgo: 12 }), 300, 12); // before the plan
    await apply(w.orgId, w.balance, await transfer(w.orgId, 700), 700, 1);
    await apply(w.orgId, w.otherReceivable, await transfer(w.orgId, 500), 500, 1); // another deal
    await apply(w.orgId, w.loose, await transfer(w.orgId, 400), 400, 1); // no deal
    expect((await record(w.orgId)).map((line) => line.invoice_id)).toEqual([w.balance]);
  });

  it("counts under the version in force when the money was applied", async () => {
    const w = await workspace("commission-versions");
    const first = await setPlan(w.orgId, w.pat, { rateBps: 1000 });
    await apply(w.orgId, w.deposit, await transfer(w.orgId, 300), 300);
    const second = await setPlan(w.orgId, w.pat, { rateBps: 2000, replaces: first.id });
    await apply(w.orgId, w.balance, await transfer(w.orgId, 700), 700);
    await record(w.orgId);
    expect((await linesOf(w.orgId)).map((line) => [line.plan_id, line.amount])).toEqual([
      [first.id, "30.000000"],
      [second.id, "140.000000"],
    ]);
  });

  it("answers only the workspace the token names", async () => {
    const a = await workspace("commission-iso-a");
    const b = await workspace("commission-iso-b");
    await planSince(b.orgId, b.pat, 5);
    await apply(b.orgId, b.deposit, await transfer(b.orgId, 300), 300, 1);
    await expect(record(b.orgId, a.orgId)).rejects.toThrow(/commission_other_workspace/);
    expect(await linesOf(b.orgId)).toHaveLength(0);
    expect(await record(b.orgId)).toHaveLength(1);
    expect(await asTenant(db, a.orgId, async (tx) => (await tx.query("select * from public.commission_lines")).rows)).toHaveLength(0);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select * from public.commission_lines"))).rejects.toThrow(/permission denied/);
      await expect(asRole(db, role, (tx) => tx.query("select * from public.record_commissions($1)", [b.orgId]))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("record_commissions (0118): adjustments", () => {
  it("adjusts a reversed payment by exactly minus its accrual, due with it while it is not paid out", async () => {
    const w = await workspace("commission-reverse");
    await planSince(w.orgId, w.pat, 5, { holdDays: 30 });
    const allocation = await apply(w.orgId, w.deposit, await transfer(w.orgId, 300), 300, 1);
    const [accrual] = await record(w.orgId);
    const reversal = await reverse(w.orgId, allocation);
    const [adjustment] = await record(w.orgId);
    expect(adjustment).toMatchObject({ kind: "adjustment", adjusts: accrual.id, allocation_id: reversal, amount: "-30.000000", reason: "allocation_reversed" });
    expect(adjustment.due_at.getTime()).toBe(accrual.due_at.getTime());
    expect(await record(w.orgId)).toHaveLength(0);
  });

  it("records nothing for a payment reversed before it was ever recorded", async () => {
    const w = await workspace("commission-reverse-early");
    await planSince(w.orgId, w.pat, 5);
    await reverse(w.orgId, await apply(w.orgId, w.deposit, await transfer(w.orgId, 300), 300, 1));
    expect(await record(w.orgId)).toHaveLength(0);
  });

  it("carries an adjustment of a commission already in a payable to the next payable", async () => {
    const w = await workspace("commission-carry");
    const owner = await createUser(db, "carry-owner@example.com");
    await planSince(w.orgId, w.pat, 10, { holdDays: 0 });
    const allocation = await apply(w.orgId, w.deposit, await transfer(w.orgId, 300), 300, 2);
    const [accrual] = await record(w.orgId);
    const first = await payout(w.orgId, w.pat, [accrual.id], owner);
    expect(first.amount).toBe(30);
    await reverse(w.orgId, allocation);
    const [adjustment] = await record(w.orgId);
    expect(adjustment.amount).toBe("-30.000000");
    expect(adjustment.due_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await invoiceOf(first.invoiceId)).amount).toBe("30.000000");
    // Nothing else is due: the adjustment alone is carried forward.
    await expect(payout(w.orgId, w.pat, [adjustment.id], owner)).rejects.toThrow(/commission_nothing_due/);
    const [next] = await (async () => {
      await apply(w.orgId, w.balance, await transfer(w.orgId, 500), 500, 1);
      return record(w.orgId);
    })();
    const second = await payout(w.orgId, w.pat, [adjustment.id, next.id].sort(), owner);
    expect(second.amount).toBe(20);
    expect(second.lineCount).toBe(2);
  });

  it("adjusts a whole match the cycle released", async () => {
    const w = await workspace("commission-released");
    await planSince(w.orgId, w.pat, 5, { holdDays: 0 });
    const paid = await wholeMatch(w.orgId, w.deposit, 300, 1);
    const [accrual] = await record(w.orgId);
    await db.query("update public.incoming_transfers set invoice_id = null where id = $1", [paid]);
    const [adjustment] = await record(w.orgId);
    expect(adjustment).toMatchObject({ adjusts: accrual.id, amount: "-30.000000", reason: "whole_match_released", allocation_id: null });
    // Matched again to the same invoice, the same money earns again, once: its next occurrence.
    await db.query("update public.incoming_transfers set invoice_id = $2 where id = $1", [paid, w.deposit]);
    const [again] = await record(w.orgId);
    expect(again).toMatchObject({ kind: "accrual", source: "whole_match", transfer_id: paid, invoice_id: w.deposit, occurrence: 2, amount: "30.000000" });
    expect(await record(w.orgId)).toHaveLength(0);
  });

  it("records nothing on a transfer the cycle claimed but has not settled the receivable with yet", async () => {
    const w = await workspace("commission-claimed");
    await planSince(w.orgId, w.pat, 5, { holdDays: 0 });
    // The cycle names the receivable on the transfer first, then settles it, and releases the claim if it cannot.
    const paid = await transfer(w.orgId, 300, { receivedDaysAgo: 1, invoiceId: w.deposit });
    expect(await record(w.orgId)).toHaveLength(0);
    await db.query("update public.incoming_transfers set invoice_id = null where id = $1", [paid]);
    expect(await record(w.orgId)).toHaveLength(0);
    expect(await linesOf(w.orgId)).toHaveLength(0);
  });

  it("never lets money that arrived before the plan earn, however it is applied again", async () => {
    const w = await workspace("commission-old-money");
    await planSince(w.orgId, w.pat, 10, { holdDays: 0 });
    // 300.00 arrived 20 days ago, before the plan; applied, reversed and applied again today.
    const old = await transfer(w.orgId, 300, { receivedDaysAgo: 20 });
    await reverse(w.orgId, await apply(w.orgId, w.deposit, old, 300, 20));
    await apply(w.orgId, w.deposit, old, 300);
    expect(await record(w.orgId)).toHaveLength(0);
    // Money that arrived after the plan, applied today, earns.
    await apply(w.orgId, w.balance, await transfer(w.orgId, 100, { receivedDaysAgo: 2 }), 100);
    expect((await record(w.orgId)).map((line) => line.amount)).toEqual(["10.000000"]);
  });

  it("records 300 rows of a kind at most per call, so an answer stays under PostgREST's 1,000 rows; the next call records the rest", async () => {
    const w = await workspace("commission-many");
    const big = await dealWith(w.orgId, w.acme, [350_000]);
    await planSince(w.orgId, w.pat, 10, { holdDays: 0 });
    for (let index = 0; index < 350; index += 1) await apply(w.orgId, big.receivables[0], await transfer(w.orgId, 1000, { receivedDaysAgo: 2 }), 1000, 1);
    expect(await record(w.orgId)).toHaveLength(300);
    expect(await record(w.orgId)).toHaveLength(50);
    expect(await record(w.orgId)).toHaveLength(0);
    expect(await linesOf(w.orgId)).toHaveLength(350);
  }, 60_000);
});

describe("create_commission_payout (0118)", () => {
  it("creates one payable for exactly the lines due, and links them", async () => {
    const w = await workspace("commission-payout");
    const owner = await createUser(db, "payout-owner@example.com");
    await planSince(w.orgId, w.pat, 40, { holdDays: 30 });
    await apply(w.orgId, w.deposit, await transfer(w.orgId, 300), 300, 35);
    await apply(w.orgId, w.balance, await transfer(w.orgId, 200), 200, 1); // still held
    const lines = await record(w.orgId);
    const due = lines.filter((line) => line.due_at.getTime() <= Date.now());
    expect(due).toHaveLength(1);
    // Held lines, or lines not shown, are refused as a change.
    await expect(payout(w.orgId, w.pat, lines.map((line) => line.id), owner)).rejects.toThrow(/commission_changed/);
    await expect(payout(w.orgId, w.pat, [], owner)).rejects.toThrow(/commission_changed/);
    const made = await payout(w.orgId, w.pat, [due[0].id], owner);
    expect(made).toMatchObject({ amount: 30, lineCount: 1 });
    expect(made.statement).toMatch(/^CS-[0-9A-F]{8}$/);
    expect(await invoiceOf(made.invoiceId)).toMatchObject({
      direction: "payable", counterparty_id: w.pat, amount: "30.000000", currency: "USDC", po_reference: made.statement, goods_received: true, status: "pending", created_by: owner,
    });
    expect((await linesOf(w.orgId)).find((line) => line.id === due[0].id)?.payout_id).toBe(made.payoutId);
    // The same lines again: they are in a payable now.
    await expect(payout(w.orgId, w.pat, [due[0].id], owner)).rejects.toThrow(/commission_changed/);
  });

  it("gives a rejected payable's lines back to the review, and keeps a line in a live payable", async () => {
    const w = await workspace("commission-rejected");
    await planSince(w.orgId, w.pat, 10, { holdDays: 0 });
    await apply(w.orgId, w.deposit, await transfer(w.orgId, 300), 300, 2);
    const [line] = await record(w.orgId);
    const first = await payout(w.orgId, w.pat, [line.id]);
    // The tenant role writes no line; whoever can, the guard keeps a line in its live payout.
    await expect(asTenant(db, w.orgId, (tx) => tx.query("update public.commission_lines set payout_id = null where id = $1", [line.id]))).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.commission_lines set payout_id = null where id = $1", [line.id])).rejects.toThrow(/commission_line_paid_out/);
    await expect(asTenant(db, w.orgId, (tx) => tx.query("update public.commission_lines set amount = 1 where id = $1", [line.id]))).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.commission_lines set amount = 1 where id = $1", [line.id])).rejects.toThrow(/commission_line_fixed/);
    await db.query("update public.invoices set status = 'rejected' where id = $1", [first.invoiceId]);
    const second = await payout(w.orgId, w.pat, [line.id]);
    expect(second.invoiceId).not.toBe(first.invoiceId);
    expect((await linesOf(w.orgId))[0].payout_id).toBe(second.payoutId);
  });

  it("frees the lines of a payable that is deleted", async () => {
    const w = await workspace("commission-deleted");
    await planSince(w.orgId, w.pat, 10, { holdDays: 0 });
    await apply(w.orgId, w.deposit, await transfer(w.orgId, 300), 300, 2);
    const [line] = await record(w.orgId);
    const made = await payout(w.orgId, w.pat, [line.id]);
    await db.query("delete from public.invoices where id = $1", [made.invoiceId]);
    expect((await linesOf(w.orgId))[0].payout_id).toBeNull();
  });

  it("refuses a line not due yet, or put into a payable already decided, whoever writes it", async () => {
    const w = await workspace("commission-not-due");
    await planSince(w.orgId, w.pat, 10, { holdDays: 30 });
    await apply(w.orgId, w.deposit, await transfer(w.orgId, 300), 300, 2);
    const [line] = await record(w.orgId);
    const payable = await one(
      "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 30, now()) returning id",
      [w.orgId, w.pat]
    );
    const payoutId = await one(
      "insert into public.commission_payouts (org_id, beneficiary_id, invoice_id, statement, currency, amount, line_count) values ($1, $2, $3, 'CS-ABCDEF12', 'USDC', 30, 1) returning id",
      [w.orgId, w.pat, payable]
    );
    await expect(db.query("update public.commission_lines set payout_id = $1 where id = $2", [payoutId, line.id])).rejects.toThrow(/commission_line_not_due/);
    await db.query("update public.invoices set status = 'held' where id = $1", [payable]);
    await expect(db.query("update public.commission_lines set payout_id = $1 where id = $2", [payoutId, line.id])).rejects.toThrow(/commission_line_payout/);
  });

  it("keeps a paid commission when the customer, its deal or its invoice is deleted", async () => {
    const w = await workspace("commission-kept");
    await planSince(w.orgId, w.pat, 10, { holdDays: 0 });
    await apply(w.orgId, w.deposit, await transfer(w.orgId, 300), 300, 2);
    const [line] = await record(w.orgId);
    const made = await payout(w.orgId, w.pat, [line.id]);
    await db.query("delete from public.counterparties where id = $1", [w.acme]);
    const [kept] = await linesOf(w.orgId);
    expect(kept).toMatchObject({ id: line.id, invoice_id: null, deal_id: null, allocation_id: null, amount: "30.000000", payout_id: made.payoutId });
    // Nothing to take back: a deleted invoice adjusts nothing.
    expect(await record(w.orgId)).toHaveLength(0);
  });
});

describe("the tenant role writes no commission directly (C1)", () => {
  it("refuses a direct insert into every commission table: only the functions write them", async () => {
    const w = await workspace("commission-direct");
    const plan = await planSince(w.orgId, w.pat, 5);
    const writes = [
      ["insert into public.commission_plans (org_id, beneficiary_id, rate_bps, basis, scope, hold_days, started_at) values ($1, $2, 9000, 'net', 'all_deals', 0, now() - interval '400 days')", [w.orgId, w.acme]],
      ["insert into public.commission_plan_deals (org_id, plan_id, deal_id) values ($1, $2, $3)", [w.orgId, plan, w.deal]],
      [
        "insert into public.commission_lines (org_id, kind, plan_id, beneficiary_id, source, basis, base_amount, rate_bps, amount, currency, applied_at, due_at) values ($1, 'accrual', $2, $3, 'payment', 'net', 1000000, 10000, 1000000, 'USDC', now(), now())",
        [w.orgId, plan, w.pat],
      ],
      ["insert into public.commission_payouts (org_id, beneficiary_id, invoice_id, statement, currency, amount, line_count) values ($1, $2, $3, 'CS-ABCDEF12', 'USDC', 1, 1)", [w.orgId, w.pat, w.loose]],
    ] as const;
    for (const [sql, params] of writes) {
      await expect(asTenant(db, w.orgId, (tx) => tx.query(sql, [...params]))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("commission plans (0118)", () => {
  it("keeps one version in force per partner, refuses a stale change, and ends the old one as the new one starts", async () => {
    const w = await workspace("commission-plans");
    const first = await setPlan(w.orgId, w.pat, { reference: "  Referral agreement 2026  " });
    await expect(setPlan(w.orgId, w.pat)).rejects.toThrow(/commission_plan_changed/);
    const second = await setPlan(w.orgId, w.pat, { rateBps: 1500, replaces: first.id });
    const ended = (await db.query<{ ended_at: Date; reference: string }>("select ended_at, reference from public.commission_plans where id = $1", [first.id])).rows[0];
    expect(ended.ended_at.getTime()).toBe(second.started_at.getTime());
    expect(ended.reference).toBe("Referral agreement 2026");
    expect(second.replaces).toBe(first.id);
    await expect(setPlan(w.orgId, w.pat, { replaces: first.id })).rejects.toThrow(/commission_plan_changed/);
    await expect(db.query("insert into public.commission_plans (org_id, beneficiary_id, rate_bps, basis, scope, hold_days) values ($1, $2, 100, 'net', 'all_deals', 0)", [w.orgId, w.pat])).rejects.toThrow(
      /commission_plans_one_active/
    );
  });

  it("is never edited, and is ended once", async () => {
    const w = await workspace("commission-fixed");
    const plan = await setPlan(w.orgId, w.pat);
    await expect(asTenant(db, w.orgId, (tx) => tx.query("update public.commission_plans set rate_bps = 9000 where id = $1", [plan.id]))).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.commission_plans set rate_bps = 9000 where id = $1", [plan.id])).rejects.toThrow(/commission_plan_fixed/);
    await expect(asTenant(db, w.orgId, (tx) => tx.query("update public.commission_plans set ended_at = now() where id = $1", [plan.id]))).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.commission_plans set ended_at = now() - interval '3 days' where id = $1", [plan.id])).rejects.toThrow(/commission_plan_ended/);
    const ended = await asTenant(db, w.orgId, async (tx) => (await tx.query<{ ended_at: Date | null }>("select * from public.end_commission_plan($1, $2, null)", [w.orgId, plan.id])).rows[0]);
    expect(ended.ended_at).not.toBeNull();
    await expect(asTenant(db, w.orgId, (tx) => tx.query("select * from public.end_commission_plan($1, $2, null)", [w.orgId, plan.id]))).rejects.toThrow(/commission_plan_changed/);
    // A new plan may start once the last one ended.
    expect((await setPlan(w.orgId, w.pat)).replaces).toBeNull();
  });

  it("refuses a client as a partner, chosen deals with none, and a deal of another workspace", async () => {
    const w = await workspace("commission-refusals");
    const other = await workspace("commission-refusals-other");
    await expect(setPlan(w.orgId, w.acme)).rejects.toThrow(/commission_beneficiary_client/);
    await expect(
      asTenant(db, w.orgId, (tx) =>
        tx.query("select * from public.set_commission_plan($1, $2, 1000, 'net', 'chosen_deals', '{}'::uuid[], 30, null, null, null, null)", [w.orgId, w.pat])
      )
    ).rejects.toThrow(/commission_no_deals/);
    await expect(setPlan(w.orgId, w.pat, { deals: [other.deal] })).rejects.toThrow(/commission_plan_deals_deal_fkey/);
    const covered = await setPlan(w.orgId, w.pat, { deals: [w.deal, w.deal] });
    expect((await db.query("select deal_id from public.commission_plan_deals where plan_id = $1", [covered.id])).rows).toEqual([{ deal_id: w.deal }]);
  });
});

describe("the partner never approves their own payout (C11)", () => {
  async function member(orgId: string, userId: string, role: string) {
    await db.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, userId, role]);
  }

  const claim = (orgId: string, actor: string, invoiceId: string, decision = "approve") =>
    asTenant(db, orgId, (tx) => tx.query("select * from public.claim_invoice_decision($1, $2, $3, $4)", [orgId, invoiceId, actor, decision]));

  /** A held payout of Pat's commission, Pat being a member; `owner` set the plan and created the payable. */
  async function heldPayout(slug: string, roles: { owner: string; partner: string } = { owner: "owner", partner: "approver" }) {
    const w = await workspace(slug);
    const owner = await createUser(db, `${slug}-owner@example.com`);
    const partner = await createUser(db, `${slug}-partner@example.com`);
    await member(w.orgId, owner, roles.owner);
    await member(w.orgId, partner, roles.partner);
    await setPlan(w.orgId, w.pat, { member: partner, holdDays: 0, by: owner });
    await apply(w.orgId, w.deposit, await transfer(w.orgId, 300), 300);
    const [line] = await record(w.orgId);
    const made = await payout(w.orgId, w.pat, [line.id], owner);
    await db.query("update public.invoices set status = 'held' where id = $1", [made.invoiceId]);
    return { ...w, owner, partner, invoiceId: made.invoiceId };
  }

  it("refuses the partner's approval in the claim, and lets another person approve", async () => {
    const w = await heldPayout("commission-claim");
    await expect(claim(w.orgId, w.partner, w.invoiceId)).rejects.toThrow(/beneficiary_approval/);
    expect((await invoiceOf(w.invoiceId)).status).toBe("held");
    const other = await createUser(db, "commission-claim-admin@example.com");
    await member(w.orgId, other, "admin");
    await claim(w.orgId, other, w.invoiceId);
    expect((await invoiceOf(w.invoiceId)).status).toBe("processing");
  });

  it("refuses it even when the partner is the only one left who may approve", async () => {
    const w = await heldPayout("commission-sole", { owner: "admin", partner: "owner" });
    await db.query("delete from public.memberships where org_id = $1 and user_id = $2", [w.orgId, w.owner]);
    const sole = await asTenant(db, w.orgId, async (tx) => (await tx.query<{ s: boolean }>("select public.sole_approver($1, $2) as s", [w.orgId, w.partner])).rows[0].s);
    expect(sole).toBe(true);
    await expect(claim(w.orgId, w.partner, w.invoiceId)).rejects.toThrow(/beneficiary_approval/);
  });

  it("refuses the partner's approval row for two approvals", async () => {
    const w = await heldPayout("commission-two");
    await expect(
      asTenant(db, w.orgId, (tx) =>
        tx.query("insert into public.payment_approvals (org_id, source_type, source_id, approved_by, amount, currency) values ($1, 'invoice', $2, $3, 30, 'USDC')", [w.orgId, w.invoiceId, w.partner])
      )
    ).rejects.toThrow(/beneficiary_approval/);
    await asTenant(db, w.orgId, (tx) =>
      tx.query("insert into public.payment_approvals (org_id, source_type, source_id, approved_by, amount, currency) values ($1, 'invoice', $2, $3, 30, 'USDC')", [w.orgId, w.invoiceId, w.owner])
    );
  });

  it("answers commission_beneficiary_approval for the partner only", async () => {
    const w = await heldPayout("commission-ask");
    const ask = (userId: string) =>
      asTenant(db, w.orgId, async (tx) => (await tx.query<{ b: boolean }>("select public.commission_beneficiary_approval($1, $2, $3) as b", [w.orgId, w.invoiceId, userId])).rows[0].b);
    expect(await ask(w.partner)).toBe(true);
    expect(await ask(w.owner)).toBe(false);
  });

  it("refuses the partner setting, ending or paying out their own plan", async () => {
    const w = await heldPayout("commission-own");
    const current = (await db.query<{ id: string }>("select id from public.commission_plans where beneficiary_id = $1 and ended_at is null", [w.pat])).rows[0].id;
    await expect(setPlan(w.orgId, w.pat, { replaces: current, by: w.partner, rateBps: 5000 })).rejects.toThrow(/commission_beneficiary/);
    await expect(asTenant(db, w.orgId, (tx) => tx.query("select * from public.end_commission_plan($1, $2, $3)", [w.orgId, current, w.partner]))).rejects.toThrow(/commission_beneficiary/);
    await expect(payout(w.orgId, w.pat, [], w.partner)).rejects.toThrow(/commission_beneficiary/);
    // Nor names themselves as the partner on a new plan.
    const self = await createUser(db, "commission-own-self@example.com");
    await member(w.orgId, self, "admin");
    await expect(setPlan(w.orgId, w.sam, { member: self, by: self })).rejects.toThrow(/commission_beneficiary: /);
    // Nor names someone who is not a member of the workspace.
    const outsider = await createUser(db, "commission-outsider@example.com");
    await expect(setPlan(w.orgId, w.sam, { member: outsider, by: w.owner })).rejects.toThrow(/commission_member_not_found/);
  });

  it("lets the owner who created it approve it when the partner is the only other approver, and no one else then", async () => {
    // Owner and partner-approver only: the partner never may, so the owner, who created it, is its only approver.
    const w = await heldPayout("commission-owner-alone");
    await claim(w.orgId, w.owner, w.invoiceId);
    expect((await invoiceOf(w.invoiceId)).status).toBe("processing");
    // With another approver beside them, the owner who created it is refused, as for any bill they enter.
    const v = await heldPayout("commission-owner-not-alone");
    const admin = await createUser(db, "commission-owner-not-alone-admin@example.com");
    await member(v.orgId, admin, "admin");
    await expect(claim(v.orgId, v.owner, v.invoiceId)).rejects.toThrow(/self_approval/);
    const alone = (orgId: string, invoiceId: string, userId: string) =>
      asTenant(db, orgId, async (tx) => (await tx.query<{ s: boolean }>("select public.commission_sole_approver($1, $2, $3) as s", [orgId, invoiceId, userId])).rows[0].s);
    expect(await alone(w.orgId, w.invoiceId, w.owner)).toBe(true);
    expect(await alone(w.orgId, w.invoiceId, w.partner)).toBe(false);
    expect(await alone(v.orgId, v.invoiceId, v.owner)).toBe(false);
  });

  it("never counts an approval the partner gave before a plan named them, and refuses one changed to them", async () => {
    const w = await heldPayout("commission-old-approval");
    const admin = await createUser(db, "commission-old-approval-admin@example.com");
    const third = await createUser(db, "commission-old-approval-third@example.com");
    await member(w.orgId, admin, "admin");
    await member(w.orgId, third, "approver");
    // An open approval by `third`, given while no plan named them; then the plan's next version names them.
    await db.query(
      "insert into public.payment_approvals (org_id, source_type, source_id, approved_by, amount, currency) values ($1, 'invoice', $2, $3, 30, 'USDC')",
      [w.orgId, w.invoiceId, third]
    );
    const current = (await db.query<{ id: string }>("select id from public.commission_plans where beneficiary_id = $1 and ended_at is null", [w.pat])).rows[0].id;
    await setPlan(w.orgId, w.pat, { member: third, holdDays: 0, replaces: current, by: w.owner });
    // The owner created it, and the only other approval on file is a partner's: it is not another person's approval.
    await expect(claim(w.orgId, w.owner, w.invoiceId)).rejects.toThrow(/self_approval/);
    // An approval moved onto a partner is refused, as one inserted is.
    const adminApproval = await one(
      "insert into public.payment_approvals (org_id, source_type, source_id, approved_by, amount, currency) values ($1, 'invoice', $2, $3, 30, 'USDC') returning id",
      [w.orgId, w.invoiceId, admin]
    );
    await expect(
      asTenant(db, w.orgId, (tx) => tx.query("update public.payment_approvals set approved_by = $1 where id = $2", [w.partner, adminApproval]))
    ).rejects.toThrow(/beneficiary_approval/);
    // The admin's approval is another person's: the owner gives the second.
    await claim(w.orgId, w.owner, w.invoiceId);
    expect((await invoiceOf(w.invoiceId)).status).toBe("processing");
  });

  it("leaves the claim as it was for a payable that pays no commission", async () => {
    const w = await heldPayout("commission-plain");
    const bill = await one(
      "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, created_by) values ($1, 'payable', $2, 10, now(), 'held', $3) returning id",
      [w.orgId, w.pat, w.owner]
    );
    await expect(claim(w.orgId, w.owner, bill)).rejects.toThrow(/self_approval/);
    await claim(w.orgId, w.partner, bill);
    expect((await invoiceOf(bill)).status).toBe("processing");
  });
});
