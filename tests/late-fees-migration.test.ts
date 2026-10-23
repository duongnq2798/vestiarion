import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asServiceRole, createDatabase, createOrg, MIGRATIONS_DIR, seedOrgRows } from "./support/pglite";

/**
 * Migration 0141 (docs/superpowers/specs/2026-10-23-late-fees-design.md LF1): a payable's late-fee term, three columns
 * set together or not at all, a percent a month of more than 0 and at most 10 or a fixed amount up to the invoice's,
 * starting on or after the due date (UTC days), the day after it when no start is given; a supplier's extra days move
 * the start with the due date; and a re-run that changes nothing.
 */

let db: PGlite;
let orgId: string;
let counterpartyId: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  // migrate.ts re-runs every file: a second run of 0141 keeps what is there.
  await applyMigrations(db, (file) => file.startsWith("0141_"));
  orgId = await createOrg(db, "late-fees");
  ({ counterpartyId } = await seedOrgRows(db, orgId, "late-fees"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

interface Bill {
  direction?: "payable" | "receivable";
  amount?: number;
  dueDate?: string;
  status?: string;
  kind?: string | null;
  value?: number | null;
  startsOn?: string | null;
}

/** An invoice due Oct 20, 2026 (noon UTC, as dueDateIso writes it), with only the late-fee columns named given. */
async function bill(input: Bill = {}): Promise<string> {
  const entries: Array<[string, unknown]> = [
    ["org_id", orgId],
    ["direction", input.direction ?? "payable"],
    ["counterparty_id", counterpartyId],
    ["amount", input.amount ?? 100],
    ["due_date", input.dueDate ?? "2026-10-20T12:00:00.000Z"],
  ];
  if (input.status !== undefined) entries.push(["status", input.status]);
  if (input.kind !== undefined) entries.push(["late_fee_kind", input.kind]);
  if (input.value !== undefined) entries.push(["late_fee_value", input.value]);
  if (input.startsOn !== undefined) entries.push(["late_fee_starts_on", input.startsOn]);
  const sql = `insert into public.invoices (${entries.map(([column]) => column).join(", ")}) values (${entries.map((_, i) => `$${i + 1}`).join(", ")}) returning id`;
  return (await db.query<{ id: string }>(sql, entries.map(([, value]) => value))).rows[0].id;
}

const term = async (id: string) =>
  (await db.query<{ late_fee_kind: string | null; late_fee_value: string | null; starts_on: string | null }>(
    "select late_fee_kind, late_fee_value, to_char(late_fee_starts_on, 'YYYY-MM-DD') as starts_on from public.invoices where id = $1",
    [id]
  )).rows[0];

describe("0141's source", () => {
  const sql = () => readFileSync(path.join(MIGRATIONS_DIR, "0141_late_fees.sql"), "utf8");

  it("ends with a schema-reload notify, so PostgREST sees the new columns before the first write that names one", () => {
    const withoutRollback = sql().replace(/\n-- Rollback:[\s\S]*$/, "").trimEnd();
    expect(withoutRollback.endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });

  it("redefines no function or view an earlier migration made: its one function is its own", () => {
    const earlier = readFileSync(path.join(MIGRATIONS_DIR, "0128_term_requests.sql"), "utf8") + readFileSync(path.join(MIGRATIONS_DIR, "0130_term_counters.sql"), "utf8");
    const functions = [...sql().matchAll(/create or replace function public\.(\w+)/g)].map((match) => match[1]);
    expect(functions).toEqual(["invoices_late_fee_start"]);
    expect(earlier).not.toContain("invoices_late_fee_start");
    expect(sql()).not.toMatch(/create (?:or replace )?view/i);
  });
});

describe("the columns (LF1)", () => {
  it("adds late_fee_kind, late_fee_value numeric(20,6) and late_fee_starts_on date, all nullable", async () => {
    const columns = await db.query<{ column_name: string; data_type: string; is_nullable: string; numeric_precision: number | null; numeric_scale: number | null }>(
      `select column_name, data_type, is_nullable, numeric_precision, numeric_scale from information_schema.columns
        where table_schema = 'public' and table_name = 'invoices' and column_name like 'late_fee_%' order by column_name`
    );
    expect(columns.rows).toEqual([
      { column_name: "late_fee_kind", data_type: "text", is_nullable: "YES", numeric_precision: null, numeric_scale: null },
      { column_name: "late_fee_starts_on", data_type: "date", is_nullable: "YES", numeric_precision: null, numeric_scale: null },
      { column_name: "late_fee_value", data_type: "numeric", is_nullable: "YES", numeric_precision: 20, numeric_scale: 6 },
    ]);
  });

  it("leaves a bill without a term as before", async () => {
    expect(await term(await bill())).toEqual({ late_fee_kind: null, late_fee_value: null, starts_on: null });
  });
});

describe("all three or none", () => {
  it("refuses a kind without a value, and a value without a kind", async () => {
    await expect(bill({ kind: "percent_month" })).rejects.toThrow(/invoices_late_fee_complete/);
    await expect(bill({ value: 1.5 })).rejects.toThrow(/invoices_late_fee_complete/);
  });

  it("refuses a start without a term", async () => {
    await expect(bill({ startsOn: "2026-10-25" })).rejects.toThrow(/invoices_late_fee_complete/);
  });

  it("refuses a kind it does not know", async () => {
    await expect(bill({ kind: "percent_year", value: 12 })).rejects.toThrow(/invoices_late_fee_kind_check/);
  });
});

describe("the value's range for its kind", () => {
  it("takes a percent a month of more than 0 and at most 10", async () => {
    await expect(bill({ kind: "percent_month", value: 0 })).rejects.toThrow(/invoices_late_fee_value_range/);
    await expect(bill({ kind: "percent_month", value: 10.01 })).rejects.toThrow(/invoices_late_fee_value_range/);
    await expect(bill({ kind: "percent_month", value: 10 })).resolves.toBeTruthy();
    await expect(bill({ kind: "percent_month", value: 1.5 })).resolves.toBeTruthy();
  });

  it("takes a fixed amount of more than 0 and at most the invoice's amount", async () => {
    await expect(bill({ kind: "fixed", value: 0 })).rejects.toThrow(/invoices_late_fee_value_range/);
    await expect(bill({ kind: "fixed", value: -5 })).rejects.toThrow(/invoices_late_fee_value_range/);
    await expect(bill({ kind: "fixed", value: 100.000001 })).rejects.toThrow(/invoices_late_fee_value_range/);
    await expect(bill({ kind: "fixed", value: 100 })).resolves.toBeTruthy();
    await expect(bill({ kind: "fixed", value: 25 })).resolves.toBeTruthy();
  });
});

describe("the start", () => {
  it("is the day after the due date when none is given", async () => {
    expect(await term(await bill({ kind: "percent_month", value: 1.5 }))).toEqual({ late_fee_kind: "percent_month", late_fee_value: "1.500000", starts_on: "2026-10-21" });
  });

  it("takes the UTC day of the due date: a due date late in the UTC day starts the fee the next day", async () => {
    expect((await term(await bill({ kind: "fixed", value: 25, dueDate: "2026-10-20T23:30:00.000Z" }))).starts_on).toBe("2026-10-21");
  });

  it("is kept as given on or after the due date", async () => {
    expect((await term(await bill({ kind: "fixed", value: 25, startsOn: "2026-10-20" }))).starts_on).toBe("2026-10-20");
    expect((await term(await bill({ kind: "fixed", value: 25, startsOn: "2026-10-30" }))).starts_on).toBe("2026-10-30");
  });

  it("refuses a start before the due date", async () => {
    await expect(bill({ kind: "fixed", value: 25, startsOn: "2026-10-19" })).rejects.toThrow(/invoices_late_fee_after_due/);
  });

  it("moves with the due date, keeping its days of grace, when the due date alone changes", async () => {
    const id = await bill({ kind: "percent_month", value: 1.5, startsOn: "2026-10-30" });
    await db.query("update public.invoices set due_date = '2026-11-03T12:00:00.000Z' where id = $1", [id]);
    expect((await term(id)).starts_on).toBe("2026-11-13");
    // Set in the same change, the start is taken as given.
    await db.query("update public.invoices set due_date = '2026-11-05T12:00:00.000Z', late_fee_starts_on = '2026-11-06' where id = $1", [id]);
    expect((await term(id)).starts_on).toBe("2026-11-06");
    // Any other change leaves it.
    await db.query("update public.invoices set memo = 'Hosting' where id = $1", [id]);
    expect((await term(id)).starts_on).toBe("2026-11-06");
  });
});

describe("payables only", () => {
  it("refuses a late fee on a receivable", async () => {
    await expect(bill({ direction: "receivable", status: "pending", kind: "fixed", value: 10 })).rejects.toThrow(/invoices_late_fee_payable/);
    await expect(bill({ direction: "receivable", status: "pending" })).resolves.toBeTruthy();
  });
});

describe("a supplier agreeing to more time (0128's accept_term_request)", () => {
  it("moves the due date of a bill with a late fee, and its start with it", async () => {
    const id = (
      await db.query<{ id: string }>(
        `insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status, late_fee_kind, late_fee_value)
         values ($1, 'payable', $2, 100, date_trunc('day', now()) + interval '4 days 12 hours', 'held', 'percent_month', 1.5) returning id`,
        [orgId, counterpartyId]
      )
    ).rows[0].id;
    const before = (await db.query<{ due: string; starts: string }>("select to_char(due_date, 'YYYY-MM-DD') as due, to_char(late_fee_starts_on, 'YYYY-MM-DD') as starts from public.invoices where id = $1", [id])).rows[0];
    const token = crypto.randomBytes(32).toString("hex");
    await asServiceRole(db, (tx) => tx.query("select * from public.create_term_request($1, $2, 7, $3, now() + interval '5 days')", [orgId, id, token]));
    expect((await asServiceRole(db, (tx) => tx.query<{ outcome: string }>("select * from public.decide_term_request($1, true)", [token]))).rows[0].outcome).toBe("accepted");
    const after = (await db.query<{ due: string; starts: string }>("select to_char(due_date, 'YYYY-MM-DD') as due, to_char(late_fee_starts_on, 'YYYY-MM-DD') as starts from public.invoices where id = $1", [id])).rows[0];
    const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;
    expect(days(before.due, after.due)).toBe(7);
    expect(days(before.starts, after.starts)).toBe(7);
    expect(days(after.due, after.starts)).toBe(1);
  });
});

describe("0141 is idempotent", () => {
  it("replays without error, keeping a row with a term unchanged", async () => {
    const id = await bill({ kind: "fixed", value: 25, startsOn: "2026-10-25" });
    const before = (await db.query("select * from public.invoices where id = $1", [id])).rows[0];
    await applyMigrations(db, (file) => file.startsWith("0141_"));
    expect((await db.query("select * from public.invoices where id = $1", [id])).rows[0]).toEqual(before);
  });
});
