import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0111 (docs/superpowers/specs/2026-10-13-project-budgets-design.md): projects, what belongs to them, and the
 * money set aside for each. A reservation is made under a lock on the project's row and refused past the budget less
 * its buffer, however it is inserted; it is released in the transaction that pays, rejects, closes, changes or moves
 * what it was for. Each workspace sees only its own.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0111_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

type Reserve = {
  state: string;
  already?: boolean;
  reservationId?: string;
  neededMinor?: number;
  budgetMinor?: number;
  bufferMinor?: number;
  reservedMinor?: number;
  paidMinor?: number;
  availableMinor?: number;
};

async function counterparty(orgId: string, role = "vendor", name = "Northwind Studio"): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, $2, $3) returning id", [orgId, name, role])).rows[0].id;
}

async function project(orgId: string, budgetMinor: number, bufferMinor = 0, name = `Project ${crypto.randomUUID().slice(0, 8)}`): Promise<string> {
  return asTenant(db, orgId, async (tx) =>
    (
      await tx.query<{ id: string }>(
        "insert into public.projects (org_id, name, budget_minor, buffer_minor, idempotency_key) values ($1, $2, $3, $4, $5) returning id",
        [orgId, name, budgetMinor, bufferMinor, `project-${crypto.randomUUID()}`]
      )
    ).rows[0].id
  );
}

async function bill(orgId: string, vendor: string, amount: number | string, projectId: string | null, extra: { currency?: string; direction?: string } = {}): Promise<string> {
  return asTenant(db, orgId, async (tx) =>
    (
      await tx.query<{ id: string }>(
        "insert into public.invoices (org_id, direction, counterparty_id, amount, currency, due_date, project_id) values ($1, $2, $3, $4, $5, '2026-10-30', $6) returning id",
        [orgId, extra.direction ?? "payable", vendor, amount, extra.currency ?? "USDC", projectId]
      )
    ).rows[0].id
  );
}

async function milestone(orgId: string, contractor: string, amount: number, projectId: string | null): Promise<string> {
  return asTenant(db, orgId, async (tx) =>
    (
      await tx.query<{ id: string }>(
        "insert into public.milestones (org_id, contractor_id, title, amount, project_id) values ($1, $2, 'Design phase', $3, $4) returning id",
        [orgId, contractor, amount, projectId]
      )
    ).rows[0].id
  );
}

const reserve = (orgId: string, subject: { invoiceId?: string; milestoneId?: string }, via = "agent") =>
  asTenant(db, orgId, async (tx) =>
    (
      await tx.query<{ r: Reserve }>("select public.reserve_project_budget($1, $2, $3, $4, null) as r", [orgId, subject.invoiceId ?? null, subject.milestoneId ?? null, via])
    ).rows[0].r
  );

const figures = (orgId: string, projectId: string) =>
  asTenant(db, orgId, async (tx) =>
    (
      await tx.query<{ reserved_minor: number; paid_minor: number; open_minor: number; open_count: number; unreserved_minor: number; unreserved_count: number }>(
        "select reserved_minor::int, paid_minor::int, open_minor::int, open_count, unreserved_minor::int, unreserved_count from public.project_figures($1) where project_id = $2",
        [orgId, projectId]
      )
    ).rows[0]
  );

const live = async (orgId: string, column: "invoice_id" | "milestone_id", id: string) =>
  (await db.query<{ amount_minor: number; release_reason: string | null }>(
    `select amount_minor::int, release_reason from public.project_reservations where org_id = $1 and ${column} = $2 order by reserved_at`,
    [orgId, id]
  )).rows;

describe("projects", () => {
  it("takes a name, a budget and a buffer within it, once per key and once per active name", async () => {
    const orgId = await createOrg(db, "projects-add");
    await project(orgId, 500_000, 50_000, "Website rebuild");
    await expect(project(orgId, 100_000, 0, " website rebuild ")).rejects.toThrow(/projects_name_key/);
    await expect(project(orgId, 100_000, 200_000)).rejects.toThrow(/projects_buffer_within_budget/);
    await expect(project(orgId, -1)).rejects.toThrow(/projects_budget_check/);
    await expect(
      asTenant(db, orgId, (tx) => tx.query("insert into public.projects (org_id, name, budget_minor, currency, idempotency_key) values ($1, 'Euro work', 1, 'EURC', 'key-eurc-12345')", [orgId]))
    ).rejects.toThrow(/projects_currency_check/);
  });

  it("lets the tenant change the name, the figures and the status only, and delete nothing", async () => {
    const orgId = await createOrg(db, "projects-change");
    const id = await project(orgId, 100_000);
    await asTenant(db, orgId, (tx) => tx.query("update public.projects set name = 'Renamed', budget_minor = 200000, buffer_minor = 10000, updated_at = now() where id = $1", [id]));
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.projects set idempotency_key = 'another-key-1' where id = $1", [id]))).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.projects set currency = 'EURC' where id = $1", [id])).rejects.toThrow(/project_fixed|projects_currency_check/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.projects where id = $1", [id]))).rejects.toThrow(/permission denied/);
  });

  it("archives a project only once nothing open is left in it, and takes nothing new once archived", async () => {
    const orgId = await createOrg(db, "projects-archive");
    const vendor = await counterparty(orgId);
    const id = await project(orgId, 100_000);
    const open = await bill(orgId, vendor, 100, id);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.projects set status = 'archived' where id = $1", [id]))).rejects.toThrow(/project_has_open_work/);
    await asTenant(db, orgId, (tx) => tx.query("update public.invoices set status = 'rejected' where id = $1", [open]));
    await asTenant(db, orgId, (tx) => tx.query("update public.projects set status = 'archived' where id = $1", [id]));
    await expect(bill(orgId, vendor, 100, id)).rejects.toThrow(/project_archived/);
    // Its name is free again for an active project.
    const name = (await db.query<{ name: string }>("select name from public.projects where id = $1", [id])).rows[0].name;
    await project(orgId, 1, 0, name);
  });
});

describe("what belongs to a project", () => {
  it("holds payables in USDC and milestones, never a receivable or a EURC bill", async () => {
    const orgId = await createOrg(db, "projects-belong");
    const vendor = await counterparty(orgId);
    const id = await project(orgId, 100_000);
    await bill(orgId, vendor, 10, id);
    await milestone(orgId, vendor, 10, id);
    await expect(bill(orgId, await counterparty(orgId, "client", "Acme"), 10, id, { direction: "receivable" })).rejects.toThrow(/project_payables_only/);
    await expect(bill(orgId, vendor, 10, id, { currency: "EURC" })).rejects.toThrow(/project_usdc_only/);
    const eurc = await bill(orgId, vendor, 10, null, { currency: "EURC" });
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.invoices set project_id = $1 where id = $2", [id, eurc]))).rejects.toThrow(/project_usdc_only/);
  });

  it("keeps the project of a bill paid or being paid, and of a paid milestone", async () => {
    const orgId = await createOrg(db, "projects-locked");
    const vendor = await counterparty(orgId);
    const id = await project(orgId, 100_000);
    const other = await project(orgId, 100_000);
    for (const status of ["paid", "matched", "processing"]) {
      const row = await bill(orgId, vendor, 10, id);
      await db.query("update public.invoices set status = $1 where id = $2", [status, row]);
      await expect(asTenant(db, orgId, (tx) => tx.query("update public.invoices set project_id = $1 where id = $2", [other, row]))).rejects.toThrow(/project_locked/);
    }
    const work = await milestone(orgId, vendor, 10, id);
    await db.query("update public.milestones set status = 'paid' where id = $1", [work]);
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.milestones set project_id = null where id = $1", [work]))).rejects.toThrow(/project_locked/);
    const held = await bill(orgId, vendor, 10, id);
    await db.query("update public.invoices set status = 'held' where id = $1", [held]);
    await asTenant(db, orgId, (tx) => tx.query("update public.invoices set project_id = $1 where id = $2", [other, held]));
  });

  it("puts a deal in an active project, and changes nothing else of the deal", async () => {
    const orgId = await createOrg(db, "projects-deal");
    const customer = await counterparty(orgId, "client", "Acme");
    const id = await project(orgId, 100_000);
    const deal = await asTenant(db, orgId, async (tx) => {
      const json = { counterpartyId: customer, title: "Website rebuild", currency: "USDC", minorDigits: 2, totalMinor: 100, startsOn: "2026-10-12", termsDays: 14, template: "custom", idempotencyKey: `deal-${crypto.randomUUID()}` };
      const lines = [{ position: 1, label: "All", invoiceOn: "2026-10-12", dueOn: "2026-10-26", amountMinor: 100 }];
      return (await tx.query<{ r: { id: string } }>("select public.create_deal($1, $2::jsonb, $3::jsonb) as r", [orgId, JSON.stringify(json), JSON.stringify(lines)])).rows[0].r.id;
    });
    await asTenant(db, orgId, (tx) => tx.query("update public.deals set project_id = $1 where id = $2", [id, deal]));
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.deals set title = 'Other' where id = $1", [deal]))).rejects.toThrow(/permission denied/);
  });
});

describe("reserve_project_budget", () => {
  it("sets a bill's money aside once, to the cent above, and answers the project's figures", async () => {
    const orgId = await createOrg(db, "reserve-once");
    const vendor = await counterparty(orgId);
    const id = await project(orgId, 100_000, 10_000);
    const row = await bill(orgId, vendor, "250.001", id);
    const first = await reserve(orgId, { invoiceId: row });
    expect(first).toMatchObject({ state: "reserved", already: false, neededMinor: 25_001, budgetMinor: 100_000, bufferMinor: 10_000, reservedMinor: 0, paidMinor: 0, availableMinor: 90_000 });
    expect(await reserve(orgId, { invoiceId: row })).toMatchObject({ state: "reserved", already: true, reservationId: first.reservationId, availableMinor: 90_000 });
    expect(await figures(orgId, id)).toEqual({ reserved_minor: 25_001, paid_minor: 0, open_minor: 25_001, open_count: 1, unreserved_minor: 0, unreserved_count: 0 });
  });

  it("refuses what the budget less its buffer cannot hold, and sets nothing aside for it", async () => {
    const orgId = await createOrg(db, "reserve-over");
    const vendor = await counterparty(orgId);
    const id = await project(orgId, 100_000, 20_000);
    expect(await reserve(orgId, { invoiceId: await bill(orgId, vendor, 600, id) })).toMatchObject({ state: "reserved" });
    const second = await bill(orgId, vendor, 300, id);
    expect(await reserve(orgId, { invoiceId: second })).toMatchObject({ state: "over", neededMinor: 30_000, reservedMinor: 60_000, availableMinor: 20_000 });
    expect(await live(orgId, "invoice_id", second)).toEqual([]);
    expect(await figures(orgId, id)).toMatchObject({ reserved_minor: 60_000, unreserved_minor: 30_000, unreserved_count: 1 });
    // The buffer is the budget's: raised past it, the budget holds the bill.
    await asTenant(db, orgId, (tx) => tx.query("update public.projects set buffer_minor = 0 where id = $1", [id]));
    expect(await reserve(orgId, { invoiceId: second })).toMatchObject({ state: "reserved" });
  });

  it("says why it had nothing to do", async () => {
    const orgId = await createOrg(db, "reserve-nothing");
    const vendor = await counterparty(orgId);
    const id = await project(orgId, 100_000);
    expect(await reserve(orgId, { invoiceId: await bill(orgId, vendor, 10, null) })).toEqual({ state: "no_project" });
    const paid = await bill(orgId, vendor, 10, id);
    await db.query("update public.invoices set status = 'paid' where id = $1", [paid]);
    expect(await reserve(orgId, { invoiceId: paid })).toMatchObject({ state: "settled" });
    expect(await reserve(orgId, { invoiceId: crypto.randomUUID() })).toEqual({ state: "not_found" });
    // Another workspace's bill is not found from here.
    const other = await createOrg(db, "reserve-nothing-other");
    const theirs = await bill(other, await counterparty(other), 10, await project(other, 100_000));
    expect(await reserve(orgId, { invoiceId: theirs })).toEqual({ state: "not_found" });
    await expect(asTenant(db, orgId, (tx) => tx.query("select public.reserve_project_budget($1, null, null, 'agent', null)", [orgId]))).rejects.toThrow(/project_subject/);
  });

  it("sets a milestone's money aside, and releases it when the milestone is closed", async () => {
    const orgId = await createOrg(db, "reserve-milestone");
    const contractor = await counterparty(orgId, "contractor", "Lan Design");
    const id = await project(orgId, 100_000);
    const work = await milestone(orgId, contractor, 800, id);
    expect(await reserve(orgId, { milestoneId: work })).toMatchObject({ state: "reserved", neededMinor: 80_000 });
    await asTenant(db, orgId, (tx) => tx.query("update public.milestones set status = 'closed' where id = $1", [work]));
    expect(await live(orgId, "milestone_id", work)).toEqual([{ amount_minor: 80_000, release_reason: "closed" }]);
    expect(await figures(orgId, id)).toMatchObject({ reserved_minor: 0, paid_minor: 0, open_count: 0 });
  });
});

describe("two decisions at once never set aside the same money", () => {
  it("refuses the second of two decisions that both read the same room before either reserved", async () => {
    const orgId = await createOrg(db, "reserve-stale-read");
    const vendor = await counterparty(orgId);
    const id = await project(orgId, 100_000);
    const a = await bill(orgId, vendor, 800, id);
    const b = await bill(orgId, vendor, 800, id);
    // Both deciders read 1,000.00 free before either acts: each, alone, would fit.
    const seen = await figures(orgId, id);
    expect(100_000 - seen.reserved_minor - seen.paid_minor).toBe(100_000);
    const [first, second] = await Promise.all([reserve(orgId, { invoiceId: a }), reserve(orgId, { invoiceId: b })]);
    expect([first.state, second.state].sort()).toEqual(["over", "reserved"]);
    expect((await figures(orgId, id)).reserved_minor).toBe(80_000);
  });

  it("never reserves past the budget however many decide at once", async () => {
    const orgId = await createOrg(db, "reserve-many");
    const vendor = await counterparty(orgId);
    const id = await project(orgId, 100_000, 5_000);
    const bills = await Promise.all(Array.from({ length: 12 }, (_, index) => bill(orgId, vendor, 100 + index, id)));
    const answers = await Promise.all(bills.map((invoiceId) => reserve(orgId, { invoiceId })));
    const reserved = answers.filter((answer) => answer.state === "reserved");
    const total = reserved.reduce((sum, answer) => sum + (answer.neededMinor ?? 0), 0);
    expect(total).toBeLessThanOrEqual(95_000);
    expect((await figures(orgId, id)).reserved_minor).toBe(total);
    expect(answers.filter((answer) => answer.state === "over").length).toBe(bills.length - reserved.length);
  });

  it("refuses an insert that skips the function, past the budget or at another amount", async () => {
    const orgId = await createOrg(db, "reserve-direct");
    const vendor = await counterparty(orgId);
    const id = await project(orgId, 50_000);
    const big = await bill(orgId, vendor, 600, id);
    const insert = (invoiceId: string, minor: number) =>
      asTenant(db, orgId, (tx) => tx.query("insert into public.project_reservations (org_id, project_id, invoice_id, amount_minor, via) values ($1, $2, $3, $4, 'agent')", [orgId, id, invoiceId, minor]));
    await expect(insert(big, 60_000)).rejects.toThrow(/project_budget_exceeded/);
    const small = await bill(orgId, vendor, 100, id);
    await expect(insert(small, 1)).rejects.toThrow(/project_reservation_mismatch/);
    await insert(small, 10_000);
    await expect(insert(small, 10_000)).rejects.toThrow(/project_reservations_live_invoice/);
    // Even the service role passes the same check.
    await expect(db.query("insert into public.project_reservations (org_id, project_id, invoice_id, amount_minor, via) values ($1, $2, $3, 60000, 'agent')", [orgId, id, big])).rejects.toThrow(/project_budget_exceeded/);
  });
});

describe("release", () => {
  it("moves a paid bill's money from reserved to paid, at what its transfer carried, in the same transaction", async () => {
    const orgId = await createOrg(db, "release-paid");
    const vendor = await counterparty(orgId);
    const id = await project(orgId, 100_000);
    const row = await bill(orgId, vendor, 500, id);
    await reserve(orgId, { invoiceId: row });
    await asTenant(db, orgId, (tx) => tx.query("update public.invoices set status = 'paid', paid_amount = 490 where id = $1", [row]));
    expect(await live(orgId, "invoice_id", row)).toEqual([{ amount_minor: 50_000, release_reason: "paid" }]);
    expect(await figures(orgId, id)).toMatchObject({ reserved_minor: 0, paid_minor: 49_000, open_count: 0 });
  });

  it("frees a rejected bill's money for the bill that was over, and a changed amount is set aside again", async () => {
    const orgId = await createOrg(db, "release-rejected");
    const vendor = await counterparty(orgId);
    const id = await project(orgId, 100_000);
    const first = await bill(orgId, vendor, 700, id);
    const waiting = await bill(orgId, vendor, 500, id);
    await reserve(orgId, { invoiceId: first });
    expect((await reserve(orgId, { invoiceId: waiting })).state).toBe("over");
    await asTenant(db, orgId, (tx) => tx.query("update public.invoices set status = 'rejected' where id = $1", [first]));
    expect(await live(orgId, "invoice_id", first)).toEqual([{ amount_minor: 70_000, release_reason: "rejected" }]);
    expect((await reserve(orgId, { invoiceId: waiting })).state).toBe("reserved");

    await asTenant(db, orgId, (tx) => tx.query("update public.invoices set amount = 450 where id = $1", [waiting]));
    expect(await live(orgId, "invoice_id", waiting)).toEqual([{ amount_minor: 50_000, release_reason: "changed" }]);
    expect(await reserve(orgId, { invoiceId: waiting })).toMatchObject({ state: "reserved", neededMinor: 45_000, reservedMinor: 0 });
  });

  it("releases a bill moved to another project, and its new project sets it aside", async () => {
    const orgId = await createOrg(db, "release-moved");
    const vendor = await counterparty(orgId);
    const from = await project(orgId, 100_000);
    const to = await project(orgId, 100_000);
    const row = await bill(orgId, vendor, 300, from);
    await reserve(orgId, { invoiceId: row });
    await asTenant(db, orgId, (tx) => tx.query("update public.invoices set project_id = $1 where id = $2", [to, row]));
    expect((await live(orgId, "invoice_id", row))[0].release_reason).toBe("moved");
    expect(await reserve(orgId, { invoiceId: row })).toMatchObject({ state: "reserved", projectId: to });
    expect((await figures(orgId, from)).reserved_minor).toBe(0);
    expect((await figures(orgId, to)).reserved_minor).toBe(30_000);
  });

  it("keeps a reservation's terms, and a release once made", async () => {
    const orgId = await createOrg(db, "release-kept");
    const vendor = await counterparty(orgId);
    const id = await project(orgId, 100_000);
    const row = await bill(orgId, vendor, 300, id);
    const reservation = (await reserve(orgId, { invoiceId: row })).reservationId;
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.project_reservations set amount_minor = 1 where id = $1", [reservation]))).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.project_reservations set amount_minor = 1 where id = $1", [reservation])).rejects.toThrow(/project_reservation_fixed/);
    await asTenant(db, orgId, (tx) => tx.query("update public.project_reservations set released_at = now(), release_reason = 'changed' where id = $1", [reservation]));
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.project_reservations set released_at = null, release_reason = null where id = $1", [reservation]))).rejects.toThrow(/project_reservation_released/);
    await expect(asTenant(db, orgId, (tx) => tx.query("delete from public.project_reservations where id = $1", [reservation]))).rejects.toThrow(/permission denied/);
  });

  it("goes with its bill when the bill is deleted, and leaves the bill when its project would be", async () => {
    const orgId = await createOrg(db, "release-deleted");
    const person = await createUser(db, "project-owner@example.com");
    const vendor = await counterparty(orgId);
    const id = await project(orgId, 100_000);
    // Who created it is kept, until their account is deleted (the foreign key's set null).
    await expect(db.query("update public.projects set created_by = $1 where id = $2", [person, id])).rejects.toThrow(/project_fixed/);
    const row = await bill(orgId, vendor, 300, id);
    await reserve(orgId, { invoiceId: row });
    await db.query("delete from public.invoices where id = $1", [row]);
    expect(await live(orgId, "invoice_id", row)).toEqual([]);
    const kept = await bill(orgId, vendor, 300, id);
    await db.query("delete from public.projects where id = $1", [id]);
    expect((await db.query<{ project_id: string | null }>("select project_id from public.invoices where id = $1", [kept])).rows[0].project_id).toBeNull();
  });
});

describe("milestones carry a purchase order", () => {
  it("takes one, and refuses a blank one", async () => {
    const orgId = await createOrg(db, "milestone-po");
    const contractor = await counterparty(orgId, "contractor", "Lan Design");
    const work = await milestone(orgId, contractor, 10, null);
    await asTenant(db, orgId, (tx) => tx.query("update public.milestones set po_reference = 'PO-1042' where id = $1", [work]));
    await expect(asTenant(db, orgId, (tx) => tx.query("update public.milestones set po_reference = '  ' where id = $1", [work]))).rejects.toThrow(/milestones_po_reference_check/);
  });
});

describe("isolation", () => {
  it("shows each workspace its own projects and reservations, refuses a link into another's, and shows the browser roles nothing", async () => {
    const mine = await createOrg(db, "projects-mine");
    const theirs = await createOrg(db, "projects-theirs");
    for (const orgId of [mine, theirs]) {
      const id = await project(orgId, 100_000);
      await reserve(orgId, { invoiceId: await bill(orgId, await counterparty(orgId), 10, id) });
    }
    for (const table of ["projects", "project_reservations"]) {
      const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ org_id: string }>(`select distinct org_id from public.${table}`)).rows.map((row) => row.org_id));
      expect(seen, table).toEqual([mine]);
      for (const role of ["anon", "authenticated"] as const) {
        await expect(asRole(db, role, (tx) => tx.query(`select 1 from public.${table}`))).rejects.toThrow(/permission denied/);
      }
    }
    const theirProject = (await db.query<{ id: string }>("select id from public.projects where org_id = $1 limit 1", [theirs])).rows[0].id;
    await expect(bill(mine, await counterparty(mine), 10, theirProject)).rejects.toThrow(/invoices_project_fkey|project_archived/);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select public.project_figures($1)", [mine]))).rejects.toThrow(/permission denied/);
    }
  });
});
