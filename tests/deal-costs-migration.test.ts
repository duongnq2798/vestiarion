import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0108 (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md): a deal's planned costs and the
 * escalations of held payables. A cost's terms never change, a link is set once to a payable (never a receivable) or a
 * milestone and never moved, a payable or milestone backs one live cost, a removal stays, and an escalation is one per
 * payable and decide-by day. Each workspace sees only its own.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0108_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function counterparty(orgId: string, role = "client", name = "Acme Studio"): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, $2, $3) returning id", [orgId, name, role])).rows[0].id;
}

async function deal(orgId: string): Promise<string> {
  const customer = await counterparty(orgId);
  const json = {
    counterpartyId: customer,
    title: "Website rebuild",
    currency: "USDC",
    minorDigits: 2,
    totalMinor: 1_000_000,
    startsOn: "2026-10-12",
    termsDays: 14,
    template: "custom",
    idempotencyKey: `key-${crypto.randomUUID()}`,
  };
  const lines = [{ position: 1, label: "All", invoiceOn: "2026-10-12", dueOn: "2026-10-26", amountMinor: 1_000_000 }];
  return asTenant(db, orgId, async (tx) => (await tx.query<{ r: { id: string } }>("select public.create_deal($1, $2::jsonb, $3::jsonb) as r", [orgId, JSON.stringify(json), JSON.stringify(lines)])).rows[0].r.id);
}

async function invoice(orgId: string, direction: "payable" | "receivable", counterpartyId: string): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, $2, $3, 1200, '2026-10-20') returning id", [orgId, direction, counterpartyId])).rows[0].id;
}

async function milestone(orgId: string, contractorId: string): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.milestones (org_id, contractor_id, title, amount) values ($1, $2, 'Design', 800) returning id", [orgId, contractorId])).rows[0].id;
}

async function addCost(orgId: string, dealId: string, over: Record<string, unknown> = {}): Promise<string> {
  const row = { label: "Contractor: design", amount_minor: 120_000, expected_on: "2026-10-20", no_document: true, idempotency_key: `cost-${crypto.randomUUID()}`, ...over };
  const columns = Object.keys(row);
  const values = Object.values(row);
  return asTenant(db, orgId, async (tx) =>
    (
      await tx.query<{ id: string }>(
        `insert into public.deal_costs (org_id, deal_id, ${columns.join(", ")}) values ($1, $2, ${columns.map((_, index) => `$${index + 3}`).join(", ")}) returning id`,
        [orgId, dealId, ...values]
      )
    ).rows[0].id
  );
}

const link = (orgId: string, costId: string, column: "invoice_id" | "milestone_id", id: string) =>
  asTenant(db, orgId, (tx) => tx.query(`update public.deal_costs set ${column} = $1, linked_at = now() where id = $2`, [id, costId]));

describe("deal_costs", () => {
  it("takes a planned cost of a deal, once per key, and refuses one with no amount, no label or another workspace's deal", async () => {
    const orgId = await createOrg(db, "costs-add");
    const other = await createOrg(db, "costs-add-other");
    const dealId = await deal(orgId);
    const key = `cost-${crypto.randomUUID()}`;
    await addCost(orgId, dealId, { idempotency_key: key });
    await expect(addCost(orgId, dealId, { idempotency_key: key })).rejects.toThrow(/deal_costs_idempotency_key/);
    await expect(addCost(orgId, dealId, { amount_minor: 0 })).rejects.toThrow(/deal_costs_amount_check/);
    await expect(addCost(orgId, dealId, { label: "  " })).rejects.toThrow(/deal_costs_label_check/);
    await expect(addCost(other, dealId)).rejects.toThrow(/deal_costs_deal_fkey/);
  });

  it("keeps a cost's terms, and lets the tenant change only its link and its removal", async () => {
    const orgId = await createOrg(db, "costs-fixed");
    const costId = await addCost(orgId, await deal(orgId));
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.deal_costs set amount_minor = 1 where id = $1", [costId]))).rejects.toThrow(/permission denied/);
    // Even the service role cannot change what a cost is.
    await expect(db.query("update public.deal_costs set amount_minor = 1 where id = $1", [costId])).rejects.toThrow(/deal_cost_fixed/);
    await expect(db.query("update public.deal_costs set expected_on = '2026-11-01' where id = $1", [costId])).rejects.toThrow(/deal_cost_fixed/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.deal_costs where id = $1", [costId]))).rejects.toThrow(/permission denied/);
  });

  it("links a cost once, to a payable or a milestone, never a receivable, and never moves it", async () => {
    const orgId = await createOrg(db, "costs-link");
    const dealId = await deal(orgId);
    const vendor = await counterparty(orgId, "vendor", "Northwind Hosting");
    const bill = await invoice(orgId, "payable", vendor);
    const another = await invoice(orgId, "payable", vendor);
    const owed = await invoice(orgId, "receivable", vendor);
    const work = await milestone(orgId, vendor);

    const first = await addCost(orgId, dealId);
    await expect(link(orgId, first, "invoice_id", owed)).rejects.toThrow(/deal_cost_not_payable/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.deal_costs set invoice_id = $1 where id = $2", [bill, first]))).rejects.toThrow(/deal_cost_linked/);
    await link(orgId, first, "invoice_id", bill);
    await expect(link(orgId, first, "invoice_id", another)).rejects.toThrow(/deal_cost_linked/);
    await expect(link(orgId, first, "milestone_id", work)).rejects.toThrow(/deal_costs_one_link|deal_cost_linked/);

    // One live cost per payable, of any deal; a removed cost frees it.
    const second = await addCost(orgId, await deal(orgId));
    await expect(link(orgId, second, "invoice_id", bill)).rejects.toThrow(/deal_costs_invoice_key/);
    await asTenant(db, orgId, (tx) => tx.query("update public.deal_costs set removed_at = now() where id = $1", [first]));
    await link(orgId, second, "invoice_id", bill);

    const third = await addCost(orgId, dealId);
    await link(orgId, third, "milestone_id", work);
    const fourth = await addCost(orgId, dealId);
    await expect(link(orgId, fourth, "milestone_id", work)).rejects.toThrow(/deal_costs_milestone_key/);
  });

  it("never clears a link by hand, so a link cannot be moved in two steps, and keeps who linked it", async () => {
    const orgId = await createOrg(db, "costs-unlink");
    const person = await createUser(db, "costs-linker@example.com");
    const vendor = await counterparty(orgId, "vendor", "Northwind Hosting");
    const bill = await invoice(orgId, "payable", vendor);
    const another = await invoice(orgId, "payable", vendor);
    const work = await milestone(orgId, vendor);
    const costId = await addCost(orgId, await deal(orgId));
    await asTenant(db, orgId, (tx) => tx.query("update public.deal_costs set invoice_id = $1, linked_at = now(), linked_by = $2 where id = $3", [bill, person, costId]));
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.deal_costs set invoice_id = null where id = $1", [costId]))).rejects.toThrow(/deal_cost_linked/);
    await expect(db.query("update public.deal_costs set invoice_id = null where id = $1", [costId])).rejects.toThrow(/deal_cost_linked/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.deal_costs set linked_by = $1 where id = $2", [person, costId]))).resolves.toBeTruthy();
    const other = await createUser(db, "costs-other-linker@example.com");
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.deal_costs set linked_by = $1 where id = $2", [other, costId]))).rejects.toThrow(/deal_cost_linked/);
    expect((await db.query<{ invoice_id: string }>("select invoice_id from public.deal_costs where id = $1", [costId])).rows[0].invoice_id).toBe(bill);

    const onMilestone = await addCost(orgId, await deal(orgId));
    await link(orgId, onMilestone, "milestone_id", work);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.deal_costs set milestone_id = null where id = $1", [onMilestone]))).rejects.toThrow(/deal_cost_linked/);
    // Its bill deleted, the cost is planned again, and may be linked to the bill that replaces it.
    await db.query("delete from public.invoices where id = $1", [bill]);
    await link(orgId, costId, "invoice_id", another);
  });

  it("refuses a link into another workspace", async () => {
    const orgId = await createOrg(db, "costs-own-link");
    const other = await createOrg(db, "costs-other-link");
    const theirBill = await invoice(other, "payable", await counterparty(other, "vendor"));
    const costId = await addCost(orgId, await deal(orgId));
    await expect(db.query("update public.deal_costs set invoice_id = $1, linked_at = now() where id = $2", [theirBill, costId])).rejects.toThrow(/deal_costs_invoice_fkey/);
  });

  it("keeps a removal, and links no removed cost", async () => {
    const orgId = await createOrg(db, "costs-removed");
    const person = await createUser(db, "costs-remover@example.com");
    const costId = await addCost(orgId, await deal(orgId));
    await asTenant(db, orgId, (tx) => tx.query("update public.deal_costs set removed_at = now(), removed_by = $1 where id = $2", [person, costId]));
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.deal_costs set removed_at = null where id = $1", [costId]))).rejects.toThrow(/deal_cost_removed/);
    const bill = await invoice(orgId, "payable", await counterparty(orgId, "vendor"));
    await expect(link(orgId, costId, "invoice_id", bill)).rejects.toThrow(/deal_cost_removed/);
    const loose = await addCost(orgId, await deal(orgId));
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.deal_costs set removed_by = $1 where id = $2", [person, loose]))).rejects.toThrow(/deal_cost_removed/);
  });

  it("leaves a cost planned when its payable, milestone or counterparty is deleted, and goes with its deal", async () => {
    const orgId = await createOrg(db, "costs-deleted");
    const dealId = await deal(orgId);
    const vendor = await counterparty(orgId, "vendor", "Gone Vendor");
    const bill = await invoice(orgId, "payable", vendor);
    const costId = await addCost(orgId, dealId, { counterparty_id: vendor });
    await link(orgId, costId, "invoice_id", bill);
    await db.query("delete from public.invoices where id = $1", [bill]);
    const after = (await db.query<{ invoice_id: string | null; counterparty_id: string | null }>("select invoice_id, counterparty_id from public.deal_costs where id = $1", [costId])).rows[0];
    expect(after.invoice_id).toBeNull();
    await db.query("delete from public.milestones where contractor_id = $1", [vendor]);
    await db.query("delete from public.counterparties where id = $1", [vendor]);
    expect((await db.query<{ counterparty_id: string | null }>("select counterparty_id from public.deal_costs where id = $1", [costId])).rows[0].counterparty_id).toBeNull();
    // delete_org deletes the invoices, then the counterparties: a deal, and its costs, go with its customer.
    await db.query("delete from public.invoices where org_id = $1", [orgId]);
    await db.query("delete from public.counterparties where org_id = $1", [orgId]);
    expect((await db.query("select 1 from public.deal_costs where org_id = $1", [orgId])).rows).toHaveLength(0);
  });
});

describe("approval_escalations", () => {
  it("is one per payable and decide-by day, released by deleting the claim, and goes with its payable", async () => {
    const orgId = await createOrg(db, "escalations");
    const bill = await invoice(orgId, "payable", await counterparty(orgId, "vendor"));
    const claim = (day: string) =>
      asTenant(db, orgId, (tx) => tx.query<{ id: string }>("insert into public.approval_escalations (org_id, invoice_id, decide_by) values ($1, $2, $3) on conflict do nothing returning id", [orgId, bill, day]));
    expect((await claim("2026-10-20")).rows).toHaveLength(1);
    expect((await claim("2026-10-20")).rows).toHaveLength(0);
    expect((await claim("2026-10-27")).rows).toHaveLength(1);
    await asTenant(db, orgId, (tx) => tx.query("update public.approval_escalations set sent_at = now(), recipients = 2, failed = 0 where invoice_id = $1 and decide_by = '2026-10-20'", [bill]));
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.approval_escalations set decide_by = '2026-10-21' where invoice_id = $1", [bill]))).rejects.toThrow(/permission denied/);
    await asTenant(db, orgId, (tx) => tx.query("delete from public.approval_escalations where invoice_id = $1 and decide_by = '2026-10-27'", [bill]));
    expect((await claim("2026-10-27")).rows).toHaveLength(1);
    await db.query("delete from public.invoices where id = $1", [bill]);
    expect((await db.query("select 1 from public.approval_escalations where org_id = $1", [orgId])).rows).toHaveLength(0);
  });
});

describe("approval_escalation_starts", () => {
  it("holds the day a workspace's escalations started, set once and never changed", async () => {
    const orgId = await createOrg(db, "escalation-start");
    const start = (day: string) =>
      asTenant(db, orgId, (tx) => tx.query<{ starts_on: string }>("insert into public.approval_escalation_starts (org_id, starts_on) values ($1, $2) on conflict do nothing returning starts_on::text", [orgId, day]));
    expect((await start("2026-10-13")).rows).toEqual([{ starts_on: "2026-10-13" }]);
    expect((await start("2026-10-14")).rows).toHaveLength(0);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.approval_escalation_starts set starts_on = '2026-01-01' where org_id = $1", [orgId]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.approval_escalation_starts where org_id = $1", [orgId]))).rejects.toThrow(/permission denied/);
    const other = await createOrg(db, "escalation-start-other");
    await expect(asTenant(db, orgId, (tx) => tx.query("insert into public.approval_escalation_starts (org_id, starts_on) values ($1, '2026-10-13')", [other]))).rejects.toThrow(/row-level security/);
  });
});

describe("isolation", () => {
  it("shows each workspace its own costs and escalations only, and none to the browser roles", async () => {
    const mine = await createOrg(db, "costs-mine");
    const theirs = await createOrg(db, "costs-theirs");
    await addCost(mine, await deal(mine));
    await addCost(theirs, await deal(theirs));
    for (const orgId of [mine, theirs]) {
      const bill = await invoice(orgId, "payable", await counterparty(orgId, "vendor"));
      await asTenant(db, orgId, (tx) => tx.query("insert into public.approval_escalations (org_id, invoice_id, decide_by) values ($1, $2, '2026-10-20')", [orgId, bill]));
    }
    for (const table of ["deal_costs", "approval_escalations"]) {
      const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ org_id: string }>(`select distinct org_id from public.${table}`)).rows.map((row) => row.org_id));
      expect(seen, table).toEqual([mine]);
      for (const role of ["anon", "authenticated"] as const) {
        await expect(asRole(db, role, (tx) => tx.query(`select 1 from public.${table}`))).rejects.toThrow(/permission denied/);
      }
    }
    await expect(addCost(mine, (await db.query<{ id: string }>("select id from public.deals where org_id = $1 limit 1", [theirs])).rows[0].id)).rejects.toThrow(/deal_costs_deal_fkey|row-level security/);
  });
});
