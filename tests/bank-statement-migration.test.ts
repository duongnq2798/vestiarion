import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asTenant, createDatabase, createOrg, createUser } from "./support/pglite";

/**
 * Migration 0094 (docs/superpowers/specs/2026-10-10-bank-statement-design.md B9, B10): the lines of a bank statement
 * kept because they record what the business paid, each unique by its hash in its workspace, read and added to only by
 * that workspace; and payment_actuals naming the line a statement's record comes from, one record per line.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // Re-runnable, as scripts/migrate.ts re-runs every file.
  await applyMigrations(db, (file) => file.startsWith("0090_") || file.startsWith("0094_"));
  await applyMigrations(db, (file) => file.startsWith("0094_"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

const hash = () => crypto.randomBytes(32).toString("hex");

async function payable(orgId: string): Promise<string> {
  const counterparty = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Supplier', 'vendor') returning id", [orgId])).rows[0].id;
  return (
    await db.query<{ id: string }>("insert into public.invoices (org_id, direction, counterparty_id, amount, due_date) values ($1, 'payable', $2, 100, now()) returning id", [orgId, counterparty])
  ).rows[0].id;
}

type LineFields = Partial<{ account: string; amount: number; currency: string; description: string; payee: string | null; reference: string | null; file_line: number; line_hash: string }>;

async function statementLine(orgId: string, fields: LineFields = {}): Promise<string> {
  const row = { account: "DBS operating", amount: -100, currency: "SGD", description: "GIRO NORTHWIND", payee: null, reference: null, file_line: 4, line_hash: hash(), ...fields };
  return (
    await db.query<{ id: string }>(
      `insert into public.bank_statement_lines (org_id, account, booked_on, value_on, amount, currency, description, payee, reference, balance, file_line, line_hash)
       values ($1, $2, '2026-10-09', '2026-10-10', $3, $4, $5, $6, $7, 3750, $8, $9) returning id`,
      [orgId, row.account, row.amount, row.currency, row.description, row.payee, row.reference, row.file_line, row.line_hash]
    )
  ).rows[0].id;
}

async function record(orgId: string, invoiceId: string, fields: { source?: string; statement_line_id?: string | null; outcome?: string; replaces?: string | null } = {}): Promise<string> {
  const paid = (fields.outcome ?? "paid") === "paid";
  return (
    await db.query<{ id: string }>(
      `insert into public.payment_actuals (org_id, invoice_id, outcome, paid_on, amount, currency, method, reason, replaces, source, statement_line_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [
        orgId,
        invoiceId,
        fields.outcome ?? "paid",
        paid ? "2026-10-09" : null,
        paid ? 100 : null,
        paid ? "SGD" : null,
        paid ? "bank_transfer" : null,
        paid ? null : "Not paid",
        fields.replaces ?? null,
        fields.source ?? "statement",
        fields.statement_line_id ?? null,
      ]
    )
  ).rows[0].id;
}

describe("bank_statement_lines (0094)", () => {
  it("keeps a line with its account, days, signed amount, text, balance, line of the file and who imported it", async () => {
    const orgId = await createOrg(db, "statement-line");
    const person = await createUser(db, "statement-owner@example.com");
    const id = await statementLine(orgId, { payee: "Northwind Cloud", reference: "INV-2207" });
    await db.query("update public.bank_statement_lines set imported_by = $1 where id = $2", [person, id]);
    const row = (
      await db.query<Record<string, string | number | null>>(
        "select account, booked_on::text, value_on::text, amount::text, currency, description, payee, reference, balance::text, file_line, imported_by from public.bank_statement_lines where id = $1",
        [id]
      )
    ).rows[0];
    expect(row).toMatchObject({ account: "DBS operating", booked_on: "2026-10-09", value_on: "2026-10-10", currency: "SGD", payee: "Northwind Cloud", reference: "INV-2207", file_line: 4, imported_by: person });
    expect(Number(row.amount)).toBe(-100);
    expect(Number(row.balance)).toBe(3750);
  });

  it("refuses a line with no account, a zero amount, a currency that is not one, an empty hash or a line before the first", async () => {
    const orgId = await createOrg(db, "statement-checks");
    await expect(statementLine(orgId, { account: "" })).rejects.toThrow(/bank_statement_lines_account_check/);
    await expect(statementLine(orgId, { account: "x".repeat(81) })).rejects.toThrow(/bank_statement_lines_account_check/);
    await expect(statementLine(orgId, { amount: 0 })).rejects.toThrow(/bank_statement_lines_amount_check/);
    await expect(statementLine(orgId, { currency: "sgd" })).rejects.toThrow(/bank_statement_lines_currency_check/);
    await expect(statementLine(orgId, { line_hash: "abc" })).rejects.toThrow(/bank_statement_lines_hash_check/);
    await expect(statementLine(orgId, { file_line: 0 })).rejects.toThrow(/bank_statement_lines_file_line_check/);
    await expect(statementLine(orgId, { reference: "r".repeat(141) })).rejects.toThrow(/bank_statement_lines_reference_check/);
    await expect(statementLine(orgId, { description: "d".repeat(501) })).rejects.toThrow(/bank_statement_lines_description_check/);
  });

  it("keeps each line once per workspace, by its hash, and the same hash in another workspace apart", async () => {
    const orgId = await createOrg(db, "statement-hash");
    const other = await createOrg(db, "statement-hash-other");
    const same = hash();
    await statementLine(orgId, { line_hash: same });
    await expect(statementLine(orgId, { line_hash: same })).rejects.toThrow(/bank_statement_lines_line_hash_key/);
    await statementLine(other, { line_hash: same });
  });

  it("is seen and added to only by its own workspace, and never changed or removed", async () => {
    const mine = await createOrg(db, "statement-tenant-a");
    const theirs = await createOrg(db, "statement-tenant-b");
    await statementLine(mine, { account: "Mine" });
    await statementLine(theirs, { account: "Theirs" });
    const seen = await asTenant(db, mine, async (tx) => (await tx.query<{ account: string }>("select account from public.bank_statement_lines")).rows);
    expect(seen).toEqual([{ account: "Mine" }]);
    const insert = (orgId: string) =>
      asTenant(db, mine, (tx) =>
        tx.query(
          "insert into public.bank_statement_lines (org_id, account, booked_on, amount, currency, description, file_line, line_hash) values ($1, 'Mine', '2026-10-09', -5, 'SGD', 'Fee', 2, $2)",
          [orgId, hash()]
        )
      );
    await insert(mine);
    await expect(insert(theirs)).rejects.toThrow(/row-level security/);
    await expect(asTenant(db, mine, (tx) => tx.query("update public.bank_statement_lines set account = 'changed'"))).rejects.toThrow(/permission denied/);
    await expect(asTenant(db, mine, (tx) => tx.query("delete from public.bank_statement_lines"))).rejects.toThrow(/permission denied/);
  });
});

describe("payment_actuals from a statement (0094)", () => {
  it("takes the source statement, with its line, for a payment", async () => {
    const orgId = await createOrg(db, "statement-record");
    const line = await statementLine(orgId);
    const id = await record(orgId, await payable(orgId), { statement_line_id: line });
    const row = (await db.query<{ source: string; statement_line_id: string }>("select source, statement_line_id from public.payment_actuals where id = $1", [id])).rows[0];
    expect(row).toEqual({ source: "statement", statement_line_id: line });
    await expect(record(orgId, await payable(orgId), { source: "bank" })).rejects.toThrow(/payment_actuals_source_check/);
  });

  it("names a line exactly when the record is a payment from a statement", async () => {
    const orgId = await createOrg(db, "statement-record-check");
    const line = await statementLine(orgId);
    await expect(record(orgId, await payable(orgId), { statement_line_id: null })).rejects.toThrow(/payment_actuals_statement_line_check/);
    await expect(record(orgId, await payable(orgId), { source: "form", statement_line_id: line })).rejects.toThrow(/payment_actuals_statement_line_check/);
    await expect(record(orgId, await payable(orgId), { outcome: "not_paid", statement_line_id: line })).rejects.toThrow(/payment_actuals_statement_line_check/);
    await record(orgId, await payable(orgId), { source: "form" });
    await record(orgId, await payable(orgId), { source: "csv" });
  });

  it("keeps one record per line, and a line in its own workspace", async () => {
    const orgId = await createOrg(db, "statement-one-record");
    const other = await createOrg(db, "statement-one-record-other");
    const line = await statementLine(orgId);
    await record(orgId, await payable(orgId), { statement_line_id: line });
    await expect(record(orgId, await payable(orgId), { statement_line_id: line })).rejects.toThrow(/payment_actuals_one_per_statement_line/);
    await expect(record(other, await payable(other), { statement_line_id: line })).rejects.toThrow(/payment_actuals_statement_line_fkey/);
  });

  it("lets a later record from the form correct a statement's, the line staying used", async () => {
    const orgId = await createOrg(db, "statement-corrected");
    const invoiceId = await payable(orgId);
    const line = await statementLine(orgId);
    const first = await record(orgId, invoiceId, { statement_line_id: line });
    await record(orgId, invoiceId, { source: "form", replaces: first });
    const used = (await db.query("select 1 from public.payment_actuals where statement_line_id = $1", [line])).rows;
    expect(used).toHaveLength(1);
  });

  it("leaves the line when its bill goes, so the next import uses it again", async () => {
    const orgId = await createOrg(db, "statement-bill-gone");
    const invoiceId = await payable(orgId);
    const line = await statementLine(orgId);
    await record(orgId, invoiceId, { statement_line_id: line });
    await db.query("delete from public.invoices where id = $1", [invoiceId]);
    expect((await db.query("select 1 from public.bank_statement_lines where id = $1", [line])).rows).toHaveLength(1);
    expect((await db.query("select 1 from public.payment_actuals where statement_line_id = $1", [line])).rows).toHaveLength(0);
  });
});
