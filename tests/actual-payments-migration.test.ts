import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0090 (docs/superpowers/specs/2026-10-10-actual-payments-design.md A2): what the business paid outside
 * Vestiarion, per payable, as a history of records each correction appends to. A paid record has its day, amount,
 * currency and method; a not-paid one its reason. One first record per bill, one correction per record, about the same
 * bill, in the same workspace. Seen and written only by its own workspace, and never changed in place.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0090_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function payable(orgId: string): Promise<string> {
  const counterparty = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Supplier', 'vendor') returning id", [orgId])).rows[0].id;
  return (
    await db.query<{ id: string }>(
      "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 100, now()) returning id",
      [orgId, counterparty]
    )
  ).rows[0].id;
}

type Fields = Partial<{
  outcome: string;
  paid_on: string | null;
  amount: number | null;
  currency: string | null;
  method: string | null;
  reference: string | null;
  note: string | null;
  reason: string | null;
  replaces: string | null;
  source: string;
}>;

const PAID: Fields = { outcome: "paid", paid_on: "2026-10-09", amount: 100, currency: "EUR", method: "bank_transfer", reason: null };
const NOT_PAID: Fields = { outcome: "not_paid", paid_on: null, amount: null, currency: null, method: null, reason: "The supplier sent a credit note" };

async function record(orgId: string, invoiceId: string, fields: Fields = PAID): Promise<string> {
  const row = { ...PAID, ...fields };
  return (
    await db.query<{ id: string }>(
      `insert into public.payment_actuals (org_id, invoice_id, outcome, paid_on, amount, currency, method, reference, note, reason, replaces, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [orgId, invoiceId, row.outcome, row.paid_on, row.amount, row.currency, row.method, row.reference ?? null, row.note ?? null, row.reason, row.replaces ?? null, row.source ?? "form"]
    )
  ).rows[0].id;
}

describe("payment_actuals (0090)", () => {
  it("keeps a paid record with its day, amount, currency and method, and who recorded it", async () => {
    const orgId = await createOrg(db, "actuals-paid");
    const invoiceId = await payable(orgId);
    const person = await createUser(db, "owner-actuals@example.com");
    const id = await record(orgId, invoiceId, { reference: "BANK-2207", note: "Paid with the October run" });
    await db.query("update public.payment_actuals set recorded_by = $1 where id = $2", [person, id]);
    const rows = (
      await db.query<{ outcome: string; paid_on: string; amount: string; currency: string; method: string; recorded_by: string; recorded_at: Date | null }>(
        "select outcome, paid_on::text, amount::text, currency, method, recorded_by, recorded_at from public.payment_actuals where id = $1",
        [id]
      )
    ).rows;
    expect(rows[0]).toMatchObject({ outcome: "paid", paid_on: "2026-10-09", currency: "EUR", method: "bank_transfer", recorded_by: person });
    expect(Number(rows[0].amount)).toBe(100);
    expect(rows[0].recorded_at).not.toBeNull();
  });

  it("takes USDC, EURC and three capital letters as the currency paid, and nothing else", async () => {
    const orgId = await createOrg(db, "actuals-currency");
    for (const currency of ["USDC", "EURC", "USD"]) await record(orgId, await payable(orgId), { currency });
    for (const currency of ["usd", "US", "DOLLARS", "USDT"]) {
      await expect(record(orgId, await payable(orgId), { currency })).rejects.toThrow(/payment_actuals_currency_check/);
    }
  });

  it("refuses a paid record without its day, a positive amount, a currency or a method, or with a reason", async () => {
    const orgId = await createOrg(db, "actuals-paid-checks");
    const invoiceId = await payable(orgId);
    await expect(record(orgId, invoiceId, { paid_on: null })).rejects.toThrow(/payment_actuals_outcome_fields/);
    await expect(record(orgId, invoiceId, { amount: null })).rejects.toThrow(/payment_actuals_outcome_fields/);
    await expect(record(orgId, invoiceId, { amount: 0 })).rejects.toThrow(/payment_actuals_amount_check/);
    await expect(record(orgId, invoiceId, { currency: null })).rejects.toThrow(/payment_actuals_outcome_fields/);
    await expect(record(orgId, invoiceId, { method: null })).rejects.toThrow(/payment_actuals_outcome_fields/);
    await expect(record(orgId, invoiceId, { method: "cheque" })).rejects.toThrow(/payment_actuals_method_check/);
    await expect(record(orgId, invoiceId, { reason: "a reason" })).rejects.toThrow(/payment_actuals_outcome_fields/);
    await expect(record(orgId, invoiceId, { outcome: "maybe" })).rejects.toThrow(/payment_actuals_outcome_check/);
  });

  it("keeps a not-paid record with a reason of at most 280 characters, and nothing else", async () => {
    const orgId = await createOrg(db, "actuals-not-paid");
    await record(orgId, await payable(orgId), NOT_PAID);
    await expect(record(orgId, await payable(orgId), { ...NOT_PAID, reason: null })).rejects.toThrow(/payment_actuals_outcome_fields/);
    await expect(record(orgId, await payable(orgId), { ...NOT_PAID, reason: "" })).rejects.toThrow(/payment_actuals_reason_check/);
    await expect(record(orgId, await payable(orgId), { ...NOT_PAID, reason: "x".repeat(281) })).rejects.toThrow(/payment_actuals_reason_check/);
    await expect(record(orgId, await payable(orgId), { ...NOT_PAID, amount: 5 })).rejects.toThrow(/payment_actuals_outcome_fields/);
  });

  it("keeps a reference to 140 characters and a note to 280, from the form or a CSV", async () => {
    const orgId = await createOrg(db, "actuals-lengths");
    await record(orgId, await payable(orgId), { reference: "r".repeat(140), note: "n".repeat(280), source: "csv" });
    await expect(record(orgId, await payable(orgId), { reference: "r".repeat(141) })).rejects.toThrow(/payment_actuals_reference_check/);
    await expect(record(orgId, await payable(orgId), { note: "n".repeat(281) })).rejects.toThrow(/payment_actuals_note_check/);
    await expect(record(orgId, await payable(orgId), { source: "api" })).rejects.toThrow(/payment_actuals_source_check/);
  });

  it("keeps the history as one line: one first record per bill, one correction per record", async () => {
    const orgId = await createOrg(db, "actuals-history");
    const invoiceId = await payable(orgId);
    const first = await record(orgId, invoiceId);
    await expect(record(orgId, invoiceId)).rejects.toThrow(/payment_actuals_first_per_invoice/);
    const second = await record(orgId, invoiceId, { amount: 60, replaces: first });
    await expect(record(orgId, invoiceId, { amount: 70, replaces: first })).rejects.toThrow(/payment_actuals_one_correction/);
    await record(orgId, invoiceId, { ...NOT_PAID, replaces: second });
    expect((await db.query("select 1 from public.payment_actuals where invoice_id = $1", [invoiceId])).rows).toHaveLength(3);
  });

  it("refuses a correction of a record about another bill, or another workspace's bill", async () => {
    const orgId = await createOrg(db, "actuals-links");
    const other = await createOrg(db, "actuals-links-other");
    const a = await payable(orgId);
    const b = await payable(orgId);
    const onA = await record(orgId, a);
    await expect(record(orgId, b, { replaces: onA })).rejects.toThrow(/payment_actuals_replaces_fkey/);
    await expect(record(other, a)).rejects.toThrow(/payment_actuals_invoice_fkey/);
  });

  // Deleting a workspace is held by tests/delete-org-migration.test.ts, which seeds this table too.
  it("goes with its bill, corrections and all", async () => {
    const orgId = await createOrg(db, "actuals-cascade");
    const invoiceId = await payable(orgId);
    const kept = await payable(orgId);
    const first = await record(orgId, invoiceId);
    await record(orgId, invoiceId, { amount: 50, replaces: first });
    await record(orgId, kept);
    await db.query("delete from public.invoices where id = $1", [invoiceId]);
    const left = (await db.query<{ invoice_id: string }>("select invoice_id from public.payment_actuals where org_id = $1", [orgId])).rows;
    expect(left).toEqual([{ invoice_id: kept }]);
  });

  it("is seen and written only by its own workspace, and never changed in place", async () => {
    const mine = await createOrg(db, "actuals-tenant-a");
    const theirs = await createOrg(db, "actuals-tenant-b");
    const myBill = await payable(mine);
    const theirBill = await payable(theirs);
    await record(mine, myBill);
    await record(theirs, theirBill, { currency: "THB" });
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ currency: string }>("select currency from public.payment_actuals")).rows);
    expect(seen).toEqual([{ currency: "EUR" }]);
    await expect(
      asTenant(db, mine, (tx) =>
        tx.query(
          "insert into public.payment_actuals (org_id, invoice_id, outcome, paid_on, amount, currency, method) values ($1, $2, 'paid', '2026-10-09', 1, 'EUR', 'cash')",
          [theirs, theirBill]
        )
      )
    ).rejects.toThrow();
    const another = await payable(mine);
    const inserted = await asTenant(db, mine, async (tx) =>
      (
        await tx.query<{ id: string }>(
          "insert into public.payment_actuals (org_id, invoice_id, outcome, reason) values ($1, $2, 'not_paid', 'Paid by a director personally') returning id",
          [mine, another]
        )
      ).rows
    );
    expect(inserted).toHaveLength(1);
    await expect(asTenant(db, mine, (tx) => tx.query("update public.payment_actuals set note = 'changed'"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine, (tx) => tx.query("delete from public.payment_actuals"))).rejects.toThrow(/permission denied/);
  });
});
