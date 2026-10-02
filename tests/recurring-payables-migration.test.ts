import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0055 (docs/superpowers/specs/2026-10-02-recurring-payables-design.md R1, R2): recurring
 * payments, each for a counterparty of its own workspace, and the invoices they create, one per
 * period by construction; seen and written only by their own workspace.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function vendor(slug: string): Promise<{ orgId: string; counterpartyId: string }> {
  const orgId = await createOrg(db, slug);
  const result = await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Hosting Co', 'vendor') returning id", [orgId]);
  return { orgId, counterpartyId: result.rows[0].id };
}

const schedule = (orgId: string, counterpartyId: string, over: Record<string, unknown> = {}) => {
  const row = { amount: 25, memo: "Monthly hosting", every_count: 1, every_unit: "month", starts_on: "2026-10-31", ...over };
  return db.query<{ id: string }>(
    `insert into public.recurring_payables (org_id, counterparty_id, amount, memo, every_count, every_unit, starts_on, ends_on, currency)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [orgId, counterpartyId, row.amount, row.memo, row.every_count, row.every_unit, row.starts_on, (over.ends_on as string | undefined) ?? null, (over.currency as string | undefined) ?? "USDC"]
  );
};

const invoice = (orgId: string, counterpartyId: string, recurringId: string | null, period: string | null) =>
  db.query(
    `insert into public.invoices (org_id, counterparty_id, direction, amount, currency, memo, due_date, status, recurring_id, recurring_period)
     values ($1, $2, 'payable', 25, 'USDC', 'Monthly hosting', now(), 'pending', $3, $4)`,
    [orgId, counterpartyId, recurringId, period]
  );

describe("recurring_payables (0055)", () => {
  it("holds a schedule, active from its first period", async () => {
    const { orgId, counterpartyId } = await vendor("rec-one");
    const { id } = (await schedule(orgId, counterpartyId)).rows[0];
    const row = (await db.query<{ status: string; next_period: number; goods_received: boolean }>("select status, next_period, goods_received from public.recurring_payables where id = $1", [id])).rows[0];
    expect(row).toEqual({ status: "active", next_period: 0, goods_received: true });
  });

  it("refuses a zero amount, an unknown unit or currency, a cadence out of range, and a last date before the first", async () => {
    const { orgId, counterpartyId } = await vendor("rec-checks");
    await expect(schedule(orgId, counterpartyId, { amount: 0 })).rejects.toThrow(/recurring_payables_amount_check/);
    await expect(schedule(orgId, counterpartyId, { every_unit: "year" })).rejects.toThrow(/recurring_payables_unit_check/);
    await expect(schedule(orgId, counterpartyId, { every_count: 0 })).rejects.toThrow(/recurring_payables_every_check/);
    await expect(schedule(orgId, counterpartyId, { currency: "BTC" })).rejects.toThrow(/recurring_payables_currency_check/);
    await expect(schedule(orgId, counterpartyId, { ends_on: "2026-01-01" })).rejects.toThrow(/recurring_payables_ends_after_start/);
  });

  it("pays only a counterparty of its own workspace, and goes with it", async () => {
    const mine = await vendor("rec-mine");
    const theirs = await vendor("rec-theirs");
    await expect(schedule(mine.orgId, theirs.counterpartyId)).rejects.toThrow(/recurring_payables_counterparty_fkey/);
    await schedule(mine.orgId, mine.counterpartyId);
    await db.query("delete from public.counterparties where id = $1", [mine.counterpartyId]);
    expect((await db.query("select 1 from public.recurring_payables where org_id = $1", [mine.orgId])).rows).toHaveLength(0);
  });

  it("lets one period have one invoice, never two (R1)", async () => {
    const { orgId, counterpartyId } = await vendor("rec-periods");
    const { id } = (await schedule(orgId, counterpartyId)).rows[0];
    await invoice(orgId, counterpartyId, id, "2026-10-31");
    await invoice(orgId, counterpartyId, id, "2026-11-30");
    await expect(invoice(orgId, counterpartyId, id, "2026-10-31")).rejects.toThrow(/invoices_recurring_period_key/);
    // Invoices typed by hand carry neither.
    await invoice(orgId, counterpartyId, null, null);
    await invoice(orgId, counterpartyId, null, null);
  });

  it("links an invoice only to a schedule of its own workspace", async () => {
    const mine = await vendor("rec-link-a");
    const theirs = await vendor("rec-link-b");
    const { id } = (await schedule(theirs.orgId, theirs.counterpartyId)).rows[0];
    await expect(invoice(mine.orgId, mine.counterpartyId, id, "2026-10-31")).rejects.toThrow(/invoices_recurring_fkey/);
  });

  it("is seen and written only by its own workspace's tenant requests", async () => {
    const mine = await vendor("rec-tenant-a");
    const theirs = await vendor("rec-tenant-b");
    await schedule(mine.orgId, mine.counterpartyId, { memo: "Mine" });
    await schedule(theirs.orgId, theirs.counterpartyId, { memo: "Theirs" });
    const seen = await asTenant(db, mine.orgId, async (tx) => (await tx.query<{ memo: string }>("select memo from public.recurring_payables")).rows);
    expect(seen.map((row) => row.memo)).toEqual(["Mine"]);
    await expect(
      asTenant(db, mine.orgId, (tx) =>
        tx.query(
          `insert into public.recurring_payables (org_id, counterparty_id, amount, memo, every_count, every_unit, starts_on) values ($1, $2, 1, 'x', 1, 'day', '2026-10-03')`,
          [theirs.orgId, theirs.counterpartyId]
        )
      )
    ).rejects.toThrow(/row-level security/);
    await expect(asRole(db, "anon", (tx) => tx.query("select 1 from public.recurring_payables"))).rejects.toThrow(/permission denied/);
  });
});
