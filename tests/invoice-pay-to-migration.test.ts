import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0136 (docs/superpowers/specs/2026-10-21-invoice-pay-to-hold-design.md IP1): the address an invoice's
 * document asked payment to, on the invoice; null by default, an address only in 0x form, the workspace's own, and
 * re-runnable.
 */

let db: PGlite;
let org: string, other: string;
let counterparty: string, theirs: string;
const ADDRESS = "0x7a2dC41e9b03F6a85d1c27e4b98f0a3c61d5e10d";

async function addCounterparty(orgId: string, name: string): Promise<string> {
  const row = await db.query<{ id: string }>(
    "insert into public.counterparties (org_id, name, role, address) values ($1, $2, 'vendor', $3) returning id",
    [orgId, name, "0x" + "1".repeat(40)]
  );
  return row.rows[0].id;
}

async function addInvoice(orgId: string, counterpartyId: string, extra: Record<string, string | null> = {}): Promise<string> {
  const columns = ["org_id", "direction", "counterparty_id", "amount", "currency", "due_date", ...Object.keys(extra)];
  const values = [orgId, "payable", counterpartyId, 10, "USDC", "2026-11-01", ...Object.values(extra)];
  const row = await db.query<{ id: string }>(
    `insert into public.invoices (${columns.join(", ")}) values (${columns.map((_, index) => `$${index + 1}`).join(", ")}) returning id`,
    values
  );
  return row.rows[0].id;
}

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  org = await createOrg(db, "pay-to-co");
  other = await createOrg(db, "pay-to-other");
  counterparty = await addCounterparty(org, "Northwind");
  theirs = await addCounterparty(other, "Elsewhere");
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("invoices' document pay-to", () => {
  it("is null for an invoice added without a document's address", async () => {
    const id = await addInvoice(org, counterparty);
    const row = await db.query<{ document_pay_to: string | null }>("select document_pay_to from public.invoices where id = $1", [id]);
    expect(row.rows[0]).toEqual({ document_pay_to: null });
  });

  it("keeps the address as the document wrote it", async () => {
    const id = await addInvoice(org, counterparty, { document_pay_to: ADDRESS });
    const row = await db.query<{ document_pay_to: string }>("select document_pay_to from public.invoices where id = $1", [id]);
    expect(row.rows[0]).toEqual({ document_pay_to: ADDRESS });
  });

  it("refuses anything but a 0x address", async () => {
    await expect(addInvoice(org, counterparty, { document_pay_to: "not an address" })).rejects.toThrow(/invoices_document_pay_to_check/);
    await expect(addInvoice(org, counterparty, { document_pay_to: `${ADDRESS}0` })).rejects.toThrow(/invoices_document_pay_to_check/);
  });

  it("is the workspace's own: the tenant role reads only its own invoices' addresses", async () => {
    await addInvoice(other, theirs, { document_pay_to: ADDRESS });
    const seen = await asTenant(db, org, (tx) => tx.query<{ org_id: string }>("select org_id from public.invoices where document_pay_to is not null"));
    expect(new Set(seen.rows.map((row) => row.org_id))).toEqual(new Set([org]));
  });

  it("runs again without error or change", async () => {
    const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/0136_invoice_document_pay_to.sql"), "utf8");
    await db.exec(sql);
    await db.exec(sql);
    const count = await db.query<{ n: number }>("select count(*)::int as n from public.invoices where document_pay_to is not null");
    expect(count.rows[0].n).toBeGreaterThan(0);
  });
});
