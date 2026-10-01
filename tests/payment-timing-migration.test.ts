import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FOUNDING_ORG_ID as A, applyMigrations, createDatabase, MIGRATIONS_DIR } from "./support/pglite";

/**
 * Migration 0038 (docs/superpowers/specs/2026-09-30-payment-timing-design.md,
 * §1 "Payment terms on an invoice" / "A new decision: schedule"): early-pay
 * discount terms, `scheduled_for` and `paid_amount` on `public.invoices`,
 * and the new status `'scheduled'`.
 */

let db: PGlite;
let counterpartyId: string;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number): string => new Date(Date.now() + n * DAY_MS).toISOString();

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  counterpartyId = (await db.query<{ id: string }>(
    "insert into public.counterparties (org_id, name, role) values ($1, 'Terms Vendor', 'vendor') returning id", [A]
  )).rows[0].id;
}, 60_000);

afterAll(async () => {
  await db.close();
});

interface InvoiceOverrides {
  status?: string;
  dueDate?: string;
  earlyPayDiscountPct?: number;
  discountDueDate?: string;
  scheduledFor?: string;
  paidAmount?: number;
}

/**
 * A payable invoice with 0038's columns controllable; only named overrides
 * are written, so an unnamed 0038 column takes its column default (null).
 * `org_id` is always named (0018's tenant with-check).
 */
async function invoice(orgId: string, overrides: InvoiceOverrides = {}): Promise<string> {
  const { status, dueDate = daysFromNow(30), earlyPayDiscountPct, discountDueDate, scheduledFor, paidAmount } = overrides;

  const entries: Array<[string, unknown]> = [
    ["org_id", orgId], ["direction", "payable"], ["counterparty_id", counterpartyId], ["amount", 100], ["due_date", dueDate],
  ];
  if (status !== undefined) entries.push(["status", status]);
  if (earlyPayDiscountPct !== undefined) entries.push(["early_pay_discount_pct", earlyPayDiscountPct]);
  if (discountDueDate !== undefined) entries.push(["discount_due_date", discountDueDate]);
  if (scheduledFor !== undefined) entries.push(["scheduled_for", scheduledFor]);
  if (paidAmount !== undefined) entries.push(["paid_amount", paidAmount]);

  const columns = entries.map(([column]) => column);
  const values = entries.map(([, value]) => value);
  const placeholders = entries.map((_, i) => `$${i + 1}`);
  const sql = `insert into public.invoices (${columns.join(", ")}) values (${placeholders.join(", ")}) returning id`;
  const result = await db.query<{ id: string }>(sql, values);
  return result.rows[0].id;
}

const migration0038Source = () => readFileSync(path.join(MIGRATIONS_DIR, "0038_payment_timing.sql"), "utf8");

describe("0038's source", () => {
  it("ends with a schema-reload notify, the way 0036 does, so PostgREST sees the new columns before the first write that names one", () => {
    const sql = migration0038Source();
    const withoutRollback = sql.replace(/\n-- Rollback:[\s\S]*$/, "").trimEnd();
    expect(withoutRollback.endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });
});

describe("invoices columns (0038)", () => {
  it("adds early_pay_discount_pct, discount_due_date, scheduled_for, paid_amount", async () => {
    const columns = await db.query<{
      column_name: string; data_type: string; is_nullable: string; numeric_precision: number | null; numeric_scale: number | null;
    }>(
      `select column_name, data_type, is_nullable, numeric_precision, numeric_scale from information_schema.columns
        where table_schema = 'public' and table_name = 'invoices'
          and column_name in ('early_pay_discount_pct', 'discount_due_date', 'scheduled_for', 'paid_amount')
        order by column_name`
    );
    expect(columns.rows).toEqual([
      { column_name: "discount_due_date", data_type: "timestamp with time zone", is_nullable: "YES", numeric_precision: null, numeric_scale: null },
      { column_name: "early_pay_discount_pct", data_type: "numeric", is_nullable: "YES", numeric_precision: 5, numeric_scale: 2 },
      { column_name: "paid_amount", data_type: "numeric", is_nullable: "YES", numeric_precision: 20, numeric_scale: 6 },
      { column_name: "scheduled_for", data_type: "timestamp with time zone", is_nullable: "YES", numeric_precision: null, numeric_scale: null },
    ]);
  });
});

describe("invoices_discount_pair", () => {
  it("refuses a percent set without a deadline", async () => {
    await expect(invoice(A, { earlyPayDiscountPct: 2 })).rejects.toThrow(/invoices_discount_pair/);
  });

  it("refuses a deadline set without a percent", async () => {
    await expect(invoice(A, { discountDueDate: daysFromNow(10) })).rejects.toThrow(/invoices_discount_pair/);
  });

  it("allows both left null", async () => {
    await expect(invoice(A)).resolves.toBeTruthy();
  });

  it("allows both set", async () => {
    await expect(invoice(A, { earlyPayDiscountPct: 2, discountDueDate: daysFromNow(10) })).resolves.toBeTruthy();
  });
});

describe("invoices_discount_pct_range", () => {
  it("refuses 0", async () => {
    await expect(invoice(A, { earlyPayDiscountPct: 0, discountDueDate: daysFromNow(10) })).rejects.toThrow(/invoices_discount_pct_range/);
  });

  it("refuses 100", async () => {
    await expect(invoice(A, { earlyPayDiscountPct: 100, discountDueDate: daysFromNow(10) })).rejects.toThrow(/invoices_discount_pct_range/);
  });

  it("refuses a negative percent", async () => {
    await expect(invoice(A, { earlyPayDiscountPct: -5, discountDueDate: daysFromNow(10) })).rejects.toThrow(/invoices_discount_pct_range/);
  });

  it("allows a percent strictly between 0 and 100", async () => {
    await expect(invoice(A, { earlyPayDiscountPct: 2, discountDueDate: daysFromNow(10) })).resolves.toBeTruthy();
  });
});

describe("invoices_discount_before_due", () => {
  it("refuses a deadline after the due date", async () => {
    await expect(
      invoice(A, { dueDate: daysFromNow(10), earlyPayDiscountPct: 2, discountDueDate: daysFromNow(20) })
    ).rejects.toThrow(/invoices_discount_before_due/);
  });

  it("allows a deadline on the due date", async () => {
    const due = daysFromNow(15);
    await expect(invoice(A, { dueDate: due, earlyPayDiscountPct: 2, discountDueDate: due })).resolves.toBeTruthy();
  });

  it("allows a deadline before the due date", async () => {
    await expect(
      invoice(A, { dueDate: daysFromNow(30), earlyPayDiscountPct: 2, discountDueDate: daysFromNow(10) })
    ).resolves.toBeTruthy();
  });

  it("allows a deadline on the due date's UTC day even at a later time of day (due_date is anchored at noon UTC, per dueDateIso)", async () => {
    await expect(
      invoice(A, {
        dueDate: "2026-10-15T12:00:00.000Z", earlyPayDiscountPct: 2, discountDueDate: "2026-10-15T23:00:00.000Z",
      })
    ).resolves.toBeTruthy();
  });

  it("refuses a deadline on the next UTC day, even a minute past midnight", async () => {
    await expect(
      invoice(A, {
        dueDate: "2026-10-15T12:00:00.000Z", earlyPayDiscountPct: 2, discountDueDate: "2026-10-16T00:30:00.000Z",
      })
    ).rejects.toThrow(/invoices_discount_before_due/);
  });
});

describe("invoices_scheduled_has_date", () => {
  it("refuses status 'scheduled' without scheduled_for", async () => {
    await expect(invoice(A, { status: "scheduled" })).rejects.toThrow(/invoices_scheduled_has_date/);
  });

  it("allows status 'scheduled' with scheduled_for set", async () => {
    await expect(invoice(A, { status: "scheduled", scheduledFor: daysFromNow(5) })).resolves.toBeTruthy();
  });

  it("allows scheduled_for set on a non-scheduled status", async () => {
    await expect(invoice(A, { status: "pending", scheduledFor: daysFromNow(5) })).resolves.toBeTruthy();
  });
});

describe("invoices_paid_amount_positive", () => {
  it("refuses 0", async () => {
    await expect(invoice(A, { paidAmount: 0 })).rejects.toThrow(/invoices_paid_amount_positive/);
  });

  it("refuses a negative paid_amount", async () => {
    await expect(invoice(A, { paidAmount: -1 })).rejects.toThrow(/invoices_paid_amount_positive/);
  });

  it("allows a positive paid_amount", async () => {
    await expect(invoice(A, { paidAmount: 50 })).resolves.toBeTruthy();
  });

  it("allows null (not named)", async () => {
    await expect(invoice(A)).resolves.toBeTruthy();
  });
});

describe("invoices_status_check (0038 adds 'scheduled')", () => {
  it("still accepts every pre-existing status", async () => {
    for (const status of ["pending", "matched", "paid", "held", "flagged", "awaiting_info", "received", "rejected", "processing"]) {
      await expect(invoice(A, { status })).resolves.toBeTruthy();
    }
  });

  it("accepts 'scheduled' when scheduled_for is set", async () => {
    await expect(invoice(A, { status: "scheduled", scheduledFor: daysFromNow(5) })).resolves.toBeTruthy();
  });

  it("refuses an unknown status", async () => {
    await expect(invoice(A, { status: "bogus" })).rejects.toThrow(/invoices_status_check/);
  });
});

describe("an older migration replayed without 0038", () => {
  // A migrate run from a checkout that lacks 0038 replays 0025 and stops
  // short of 0038, so nothing would put back a constraint 0025's status-check
  // rebuild dropped. That rebuild must leave 0038's other checks alone, even
  // the one that names `status`.
  it("keeps every 0038 check when 0025 is replayed on its own", async () => {
    const checks = async () =>
      (await db.query<{ conname: string }>(
        "select conname from pg_constraint where conrelid = 'public.invoices'::regclass and contype = 'c' order by 1"
      )).rows.map((row) => row.conname);
    const before = await checks();
    expect(before).toContain("invoices_scheduled_has_date");

    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, "0025_control.sql"), "utf8"));

    expect(await checks()).toEqual(before);
  });
});

describe("0038 is idempotent", () => {
  it("replays twice without error, keeping an already-shaped row unchanged", async () => {
    const id = await invoice(A, {
      status: "scheduled", dueDate: daysFromNow(30), scheduledFor: daysFromNow(3),
      earlyPayDiscountPct: 2, discountDueDate: daysFromNow(3), paidAmount: 98,
    });
    const before = (await db.query("select * from public.invoices where id = $1", [id])).rows[0];

    await applyMigrations(db);
    await applyMigrations(db);

    expect((await db.query("select * from public.invoices where id = $1", [id])).rows[0]).toEqual(before);
  });
});
