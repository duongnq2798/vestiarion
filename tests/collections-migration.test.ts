import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0064 (docs/superpowers/specs/2026-10-03-collections-design.md §4): a pay link's kept token and its
 * reminders, and each reminder sent, once per receivable and number (R7), seen only by its own workspace; and a
 * migration that runs again without harm, as db:migrate runs every file.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function receivable(orgId: string): Promise<string> {
  const client = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Acme', 'client') returning id", [orgId])).rows[0].id;
  return (
    await db.query<{ id: string }>("insert into public.invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'receivable', $2, 12.5, now()) returning id", [
      orgId,
      client,
    ])
  ).rows[0].id;
}

describe("collections (0064)", () => {
  it("keeps a link's token and its reminders on the link", async () => {
    const columns = (
      await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'receivable_links' and column_name in ('token_enc', 'reminders_on_at', 'reminders_on_by', 'reminder_deferred_until') order by column_name"
      )
    ).rows.map((row) => row.column_name);
    expect(columns).toEqual(["reminder_deferred_until", "reminders_on_at", "reminders_on_by", "token_enc"]);
  });

  it("records each reminder once per receivable and number, 1 to 4, in one of three tones (R7)", async () => {
    const orgId = await createOrg(db, "collections-once");
    const invoiceId = await receivable(orgId);
    await db.query("insert into public.ar_reminders (org_id, invoice_id, number, tone) values ($1, $2, 1, 'friendly')", [orgId, invoiceId]);
    await expect(db.query("insert into public.ar_reminders (org_id, invoice_id, number, tone) values ($1, $2, 1, 'firm')", [orgId, invoiceId])).rejects.toThrow(
      /ar_reminders_invoice_number_key/
    );
    await expect(db.query("insert into public.ar_reminders (org_id, invoice_id, number, tone) values ($1, $2, 5, 'firm')", [orgId, invoiceId])).rejects.toThrow(/ar_reminders_number_check/);
    await expect(db.query("insert into public.ar_reminders (org_id, invoice_id, number, tone) values ($1, $2, 2, 'angry')", [orgId, invoiceId])).rejects.toThrow(/ar_reminders_tone_check/);
  });

  it("goes with its receivable, and never points at another workspace's", async () => {
    const mine = await createOrg(db, "collections-mine");
    const theirs = await createOrg(db, "collections-theirs");
    const theirInvoice = await receivable(theirs);
    await expect(db.query("insert into public.ar_reminders (org_id, invoice_id, number, tone) values ($1, $2, 1, 'friendly')", [mine, theirInvoice])).rejects.toThrow(
      /ar_reminders_invoice_fkey/
    );
    const own = await receivable(mine);
    await db.query("insert into public.ar_reminders (org_id, invoice_id, number, tone) values ($1, $2, 1, 'friendly')", [mine, own]);
    await db.query("delete from public.invoices where id = $1", [own]);
    expect((await db.query("select 1 from public.ar_reminders where invoice_id = $1", [own])).rows).toHaveLength(0);
  });

  it("is seen only by its own workspace's tenant requests", async () => {
    const mine = await createOrg(db, "collections-tenant-a");
    const theirs = await createOrg(db, "collections-tenant-b");
    const invoiceId = await receivable(theirs);
    await db.query("insert into public.ar_reminders (org_id, invoice_id, number, tone) values ($1, $2, 1, 'friendly')", [theirs, invoiceId]);
    const seen = await asTenant(db, mine, async (tx) => (await tx.query("select 1 from public.ar_reminders where invoice_id = $1", [invoiceId])).rows);
    expect(seen).toHaveLength(0);
    const own = await asTenant(db, theirs, async (tx) => (await tx.query("select 1 from public.ar_reminders where invoice_id = $1", [invoiceId])).rows);
    expect(own).toHaveLength(1);
  });

  it("runs again without harm", async () => {
    await expect(applyMigrations(db, (file) => file.startsWith("0064_"))).resolves.toBeUndefined();
  });
});
