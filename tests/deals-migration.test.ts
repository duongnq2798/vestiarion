import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0104 (docs/superpowers/specs/2026-10-12-deal-schedule-design.md): deals, their versions and their lines, the
 * link from a receivable to the line it was released from, and the two functions that write a version whole. The lines
 * in force at every version add up to its total, a line is never changed, a released line never moves back while its
 * receivable exists, one receivable per line, and each workspace sees only its own.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0104_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function client(orgId: string, name = "Acme Studio"): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, $2, 'client') returning id", [orgId, name])).rows[0].id;
}

const lines = [
  { position: 1, label: "Deposit (30%)", invoiceOn: "2026-10-12", dueOn: "2026-10-26", amountMinor: 300_000, roundingMinor: 0 },
  { position: 2, label: "Balance on delivery", invoiceOn: "2026-12-01", dueOn: "2026-12-15", amountMinor: 700_000, roundingMinor: 0 },
];

function dealJson(counterpartyId: string, over: Record<string, unknown> = {}) {
  return {
    counterpartyId,
    title: "Website rebuild",
    currency: "USDC",
    minorDigits: 2,
    totalMinor: 1_000_000,
    startsOn: "2026-10-12",
    termsDays: 14,
    externalRef: null,
    template: "deposit",
    autoRelease: false,
    idempotencyKey: `key-${crypto.randomUUID()}`,
    createdBy: null,
    changes: [],
    ...over,
  };
}

async function createDeal(orgId: string, deal: Record<string, unknown>, rows: unknown[] = lines): Promise<{ id: string; created: boolean }> {
  return asTenant(db, orgId, async (tx) => (await tx.query<{ r: { id: string; created: boolean } }>("select public.create_deal($1, $2::jsonb, $3::jsonb) as r", [orgId, JSON.stringify(deal), JSON.stringify(rows)])).rows[0].r);
}

async function revise(orgId: string, dealId: string, base: number, revision: Record<string, unknown>): Promise<{ version: number; created: boolean }> {
  return asTenant(db, orgId, async (tx) =>
    (await tx.query<{ r: { version: number; created: boolean } }>("select public.revise_deal($1, $2, $3, $4::jsonb) as r", [orgId, dealId, base, JSON.stringify(revision)])).rows[0].r
  );
}

async function lineIds(dealId: string): Promise<Array<{ id: string; position: number; status: string }>> {
  return (await db.query<{ id: string; position: number; status: string }>("select id, position, status from public.deal_lines where deal_id = $1 order by position", [dealId])).rows;
}

async function release(orgId: string, lineId: string): Promise<void> {
  await asTenant(db, orgId, (tx) => tx.query("update public.deal_lines set status = 'released', released_at = now(), released_via = 'person' where id = $1 and status = 'planned'", [lineId]));
}

async function receivable(orgId: string, counterpartyId: string, dealId: string, lineId: string, direction = "receivable"): Promise<string> {
  return (
    await asTenant(db, orgId, (tx) =>
      tx.query<{ id: string }>(
        "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, deal_id, deal_line_id) values ($1, $2, $3, 3000, now(), $4, $5) returning id",
        [orgId, direction, counterpartyId, dealId, lineId]
      )
    )
  ).rows[0].id;
}

describe("create_deal", () => {
  it("writes the deal, its signed first version and its lines, and answers the same deal for the same key", async () => {
    const orgId = await createOrg(db, "deals-create");
    const cp = await client(orgId);
    const person = await createUser(db, "deals-owner@example.com");
    const deal = dealJson(cp, { createdBy: person, externalRef: "hubspot-881" });
    const first = await createDeal(orgId, deal);
    expect(first.created).toBe(true);
    const again = await createDeal(orgId, deal);
    expect(again).toEqual({ id: first.id, created: false });
    const rows = (await db.query<{ n: number }>("select count(*)::int as n from public.deals where org_id = $1", [orgId])).rows[0].n;
    expect(rows).toBe(1);
    const version = (await db.query<{ version: number; kind: string; total_minor: string; created_by: string }>("select version, kind, total_minor::text, created_by from public.deal_versions where deal_id = $1", [first.id])).rows;
    expect(version).toEqual([{ version: 1, kind: "signed", total_minor: "1000000", created_by: person }]);
    expect((await lineIds(first.id)).map((line) => [line.position, line.status])).toEqual([
      [1, "planned"],
      [2, "planned"],
    ]);
  });

  it("refuses lines that do not add up to the total, at commit", async () => {
    const orgId = await createOrg(db, "deals-sum");
    const cp = await client(orgId);
    await expect(createDeal(orgId, dealJson(cp, { totalMinor: 1_100_000 }))).rejects.toThrow(/deal_sum_mismatch/);
    expect((await db.query("select 1 from public.deals where org_id = $1", [orgId])).rows).toHaveLength(0);
  });

  it("refuses VND, a stablecoin it does not know, and an external reference used by another deal", async () => {
    const orgId = await createOrg(db, "deals-currency");
    const cp = await client(orgId);
    await expect(createDeal(orgId, dealJson(cp, { currency: "VND", minorDigits: 0 }))).rejects.toThrow(/deals_currency_check/);
    await expect(createDeal(orgId, dealJson(cp, { currency: "usdc" }))).rejects.toThrow(/deals_currency_check/);
    await createDeal(orgId, dealJson(cp, { currency: "JPY", minorDigits: 0, externalRef: "crm-1" }));
    await expect(createDeal(orgId, dealJson(cp, { externalRef: "crm-1" }))).rejects.toThrow(/deals_external_ref_key/);
  });

  it("refuses a customer from another workspace", async () => {
    const orgId = await createOrg(db, "deals-own-customer");
    const other = await createOrg(db, "deals-other-customer");
    const theirs = await client(other);
    await expect(createDeal(orgId, dealJson(theirs))).rejects.toThrow(/deals_counterparty_fkey/);
  });
});

describe("revise_deal", () => {
  it("ends planned lines and adds new ones as the next version, and refuses a stale base or a released line", async () => {
    const orgId = await createOrg(db, "deals-revise");
    const cp = await client(orgId);
    const { id } = await createDeal(orgId, dealJson(cp));
    const [deposit, balance] = await lineIds(id);
    await release(orgId, deposit.id);

    const key = `rev-${crypto.randomUUID()}`;
    const revision = {
      kind: "revised",
      totalMinor: 1_200_000,
      reason: "Extra page",
      changes: [{ what: "amount" }],
      idempotencyKey: key,
      end: [{ id: balance.id, status: "superseded" }],
      add: [{ position: 3, kind: "charge", label: "Balance on delivery", invoiceOn: "2026-12-01", dueOn: "2026-12-15", amountMinor: 900_000, replaces: balance.id }],
    };
    expect(await revise(orgId, id, 1, revision)).toEqual({ version: 2, created: true });
    // The same change again answers the version made, and makes no third.
    expect(await revise(orgId, id, 1, revision)).toEqual({ version: 2, created: false });
    const deal = (await db.query<{ current_version: number; total_minor: string }>("select current_version, total_minor::text from public.deals where id = $1", [id])).rows[0];
    expect(deal).toEqual({ current_version: 2, total_minor: "1200000" });
    expect((await lineIds(id)).map((line) => [line.position, line.status])).toEqual([
      [1, "released"],
      [2, "superseded"],
      [3, "planned"],
    ]);

    await expect(revise(orgId, id, 1, { ...revision, idempotencyKey: `rev-${crypto.randomUUID()}` })).rejects.toThrow(/deal_changed/);
    await expect(
      revise(orgId, id, 2, { kind: "revised", totalMinor: 900_000, idempotencyKey: `rev-${crypto.randomUUID()}`, end: [{ id: deposit.id, status: "cancelled" }], add: [{ position: 4, kind: "charge", label: "Smaller deposit", invoiceOn: "2026-10-12", dueOn: "2026-10-26", amountMinor: 0 }] })
    ).rejects.toThrow(/deal_line_not_planned|deal_lines_amount_sign/);
  });

  it("cancels: the version's total is what was released, and a cancelled deal is only reopened", async () => {
    const orgId = await createOrg(db, "deals-cancel");
    const cp = await client(orgId);
    const { id } = await createDeal(orgId, dealJson(cp));
    const [deposit, balance] = await lineIds(id);
    await release(orgId, deposit.id);
    await revise(orgId, id, 1, { kind: "cancelled", totalMinor: 300_000, end: [{ id: balance.id, status: "cancelled" }], add: [] });
    expect((await db.query<{ status: string }>("select status from public.deals where id = $1", [id])).rows[0].status).toBe("cancelled");
    await expect(revise(orgId, id, 2, { kind: "revised", totalMinor: 300_000, end: [], add: [] })).rejects.toThrow(/deal_status/);
    await expect(revise(orgId, id, 2, { kind: "cancelled", totalMinor: 300_000, end: [], add: [] })).rejects.toThrow(/deal_status/);
    expect(
      await revise(orgId, id, 2, {
        kind: "reopened",
        totalMinor: 800_000,
        end: [],
        add: [{ position: 3, kind: "charge", label: "Reduced scope", invoiceOn: "2026-12-10", dueOn: "2026-12-24", amountMinor: 500_000 }],
      })
    ).toEqual({ version: 3, created: true });
    expect((await db.query<{ status: string }>("select status from public.deals where id = $1", [id])).rows[0].status).toBe("active");
  });

  it("refuses a version whose lines do not add up to its total", async () => {
    const orgId = await createOrg(db, "deals-revise-sum");
    const cp = await client(orgId);
    const { id } = await createDeal(orgId, dealJson(cp));
    await expect(revise(orgId, id, 1, { kind: "revised", totalMinor: 1_500_000, end: [], add: [] })).rejects.toThrow(/deal_sum_mismatch/);
    expect((await db.query<{ current_version: number }>("select current_version from public.deals where id = $1", [id])).rows[0].current_version).toBe(1);
  });

  it("finds no deal of another workspace", async () => {
    const orgId = await createOrg(db, "deals-revise-own");
    const other = await createOrg(db, "deals-revise-other");
    const { id } = await createDeal(other, dealJson(await client(other)));
    await expect(revise(orgId, id, 1, { kind: "cancelled", totalMinor: 0, end: [], add: [] })).rejects.toThrow(/deal_not_found/);
  });
});

describe("a line is never changed", () => {
  it("keeps the tenant to a line's status and release", async () => {
    const orgId = await createOrg(db, "deals-columns");
    const { id } = await createDeal(orgId, dealJson(await client(orgId)));
    const [deposit] = await lineIds(id);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.deal_lines set amount_minor = 1 where id = $1", [deposit.id]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.deals set title = 'Other' where id = $1", [id]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.deal_lines where id = $1", [deposit.id]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.deal_versions set reason = 'x' where deal_id = $1", [id]))).rejects.toThrow(/permission denied/);
  });

  it("refuses a change to a line's terms even from the service role, and a status moving backwards", async () => {
    const orgId = await createOrg(db, "deals-guard");
    const cp = await client(orgId);
    const { id } = await createDeal(orgId, dealJson(cp));
    const [deposit, balance] = await lineIds(id);
    await expect(db.query("update public.deal_lines set invoice_on = '2026-10-13' where id = $1", [deposit.id])).rejects.toThrow(/deal_line_fixed/);
    await release(orgId, deposit.id);
    await expect(db.query("update public.deal_lines set released_at = now() - interval '1 day' where id = $1", [deposit.id])).rejects.toThrow(/deal_line_released/);
    await receivable(orgId, cp, id, deposit.id);
    // Its receivable exists: the release stays.
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.deal_lines set status = 'planned', released_at = null, released_via = null where id = $1", [deposit.id]))).rejects.toThrow(
      /deal_line_status/
    );
    // A release whose receivable was never made is undone.
    await release(orgId, balance.id);
    await asTenant(db, orgId, (tx) => tx.query("update public.deal_lines set status = 'planned', released_at = null, released_via = null where id = $1", [balance.id]));
    expect((await lineIds(id)).map((line) => line.status)).toEqual(["released", "planned"]);
  });
});

describe("the receivable a line became", () => {
  it("is one per line, a receivable only, in the line's own deal, and stays with its line", async () => {
    const orgId = await createOrg(db, "deals-link");
    const cp = await client(orgId);
    const { id } = await createDeal(orgId, dealJson(cp));
    const other = (await createDeal(orgId, dealJson(cp))).id;
    const [deposit, balance] = await lineIds(id);
    const invoiceId = await receivable(orgId, cp, id, deposit.id);
    await expect(receivable(orgId, cp, id, deposit.id)).rejects.toThrow(/invoices_deal_line_key/);
    await expect(receivable(orgId, cp, id, balance.id, "payable")).rejects.toThrow(/invoices_deal_receivable/);
    await expect(receivable(orgId, cp, other, balance.id)).rejects.toThrow(/invoices_deal_line_fkey/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.invoices set deal_line_id = $1 where id = $2", [balance.id, invoiceId]))).rejects.toThrow(/invoice_deal_link_fixed/);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.invoices set deal_line_id = null where id = $1", [invoiceId]))).rejects.toThrow(/invoices_deal_pair/);
  });
});

describe("isolation", () => {
  it("shows each workspace its own deals only, and deletes them with their customer, as deleting a workspace does", async () => {
    const mine = await createOrg(db, "deals-mine");
    const theirs = await createOrg(db, "deals-theirs");
    await createDeal(mine, dealJson(await client(mine)));
    await createDeal(theirs, dealJson(await client(theirs)));
    for (const table of ["deals", "deal_versions", "deal_lines"]) {
      const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ org_id: string }>(`select distinct org_id from public.${table}`)).rows.map((row) => row.org_id));
      expect(seen, table).toEqual([mine]);
    }
    // delete_org deletes the invoices, then the counterparties, then the workspace: a deal goes with its customer.
    await db.query("delete from public.invoices where org_id = $1", [theirs]);
    await db.query("delete from public.counterparties where org_id = $1", [theirs]);
    for (const table of ["deals", "deal_versions", "deal_lines"]) {
      expect((await db.query(`select 1 from public.${table} where org_id = $1`, [theirs])).rows, table).toHaveLength(0);
    }
  });
});
