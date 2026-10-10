import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { ActualRecord } from "@/lib/actual-payment-fields";
import { ActualPaymentError } from "@/lib/actual-payments";
import type { MatchBill } from "@/lib/actual-payments-csv";
import type { Actor } from "@/lib/commands/actor";
import { importActualPayments, recordActualPayment } from "@/lib/commands/actuals";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Recording what the business paid as commands (docs/superpowers/specs/2026-10-10-actual-payments-design.md A4): the
 * same roles that add invoices (`records.write`: owners and admins) record it, from the console only; the gate runs
 * before anything is read, and a domain refusal reads in its own words.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { recordActual: vi.fn(), readMatchBills: vi.fn() } }));
vi.mock("@/lib/actual-payments", async (original) => ({
  ...(await original<typeof import("@/lib/actual-payments")>()),
  recordActual: mocks.recordActual,
  readMatchBills: mocks.readMatchBills,
}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a71";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a7";
const INVOICE = "018f8ce0-1557-7b54-a931-4d777f6ba071";
const OTHER = "018f8ce0-1557-7b54-a931-4d777f6ba072";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), fn);
const actor = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "owner", mode: "live", surface: { kind: "console" }, ...fields });

const PAID = { invoiceId: INVOICE, outcome: "paid" as const, paidOn: "2026-10-09", amount: "1,250.00", currency: "EUR", method: "bank_transfer" };
const record = (over: Partial<ActualRecord> = {}): ActualRecord => ({
  id: "rec-1",
  invoiceId: INVOICE,
  outcome: "paid",
  paidOn: "2026-10-09",
  amount: 1250,
  currency: "EUR",
  method: "bank_transfer",
  reference: null,
  note: null,
  reason: null,
  replaces: null,
  source: "form",
  recordedBy: USER,
  recordedAt: "2026-10-10T08:00:00.000Z",
  ...over,
});
const bill = (id: string, over: Partial<MatchBill> = {}): MatchBill => ({ id, memo: null, payee: "Northwind", amount: 100, currency: "USDC", bill: null, dueDate: null, current: null, ...over });

beforeEach(() => {
  mocks.recordActual.mockReset();
  mocks.readMatchBills.mockReset();
});

describe("who may record what the business paid", () => {
  it("is the same permission that adds invoices, from the console only", () => {
    expect(COMMAND_PERMISSIONS["payable.record_actual"]).toBe("records.write");
    expect(COMMAND_PERMISSIONS["payable.import_actuals"]).toBe("records.write");
    for (const surface of ["api", "slack", "telegram", "github"] as const) {
      expect(SURFACE_COMMANDS[surface]).not.toContain("payable.record_actual");
      expect(SURFACE_COMMANDS[surface]).not.toContain("payable.import_actuals");
    }
  });

  it.each(["owner", "admin"] as const)("lets an %s record it", async (role) => {
    mocks.recordActual.mockResolvedValueOnce({ record: record(), corrected: false });
    const outcome = await run(() => recordActualPayment(actor({ role }), { ...PAID, today: "2026-10-10" }));
    expect(outcome).toEqual({ ok: true, message: "Recorded: your business paid 1,250.00 EUR on Oct 9, 2026.", actualId: "rec-1", corrected: false });
    expect(mocks.recordActual).toHaveBeenCalledWith({ ...PAID, today: "2026-10-10", actorId: USER, source: "form" });
  });

  it.each(["approver", "viewer"] as const)("refuses an %s before anything is read", async (role) => {
    const outcome = await run(() => recordActualPayment(actor({ role }), PAID));
    expect(outcome).toMatchObject({ ok: false, code: "forbidden" });
    const imported = await run(() => importActualPayments(actor({ role }), { csv: "invoice,paid_date,amount\nA,2026-10-09,1" }));
    expect(imported).toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.recordActual).not.toHaveBeenCalled();
    expect(mocks.readMatchBills).not.toHaveBeenCalled();
  });

  it("refuses a surface other than the console", async () => {
    const outcome = await run(() => recordActualPayment(actor({ surface: { kind: "api", apiKeyId: "k-1" } }), PAID));
    expect(outcome).toMatchObject({ ok: false, code: "surface" });
  });
});

describe("recordActualPayment", () => {
  it("says a correction and a bill not paid in plain words", async () => {
    mocks.recordActual.mockResolvedValueOnce({ record: record({ outcome: "not_paid", paidOn: null, amount: null, currency: null, method: null, reason: "Credit note" }), corrected: true });
    const outcome = await run(() => recordActualPayment(actor(), { invoiceId: INVOICE, outcome: "not_paid", reason: "Credit note", replaces: "rec-0" }));
    expect(outcome).toMatchObject({ ok: true, message: "Corrected: your business did not pay it.", corrected: true });
  });

  it("returns a domain refusal in its own words, and anything else as a try-again", async () => {
    mocks.recordActual.mockRejectedValueOnce(new ActualPaymentError("not_ready"));
    expect(await run(() => recordActualPayment(actor(), PAID))).toEqual({
      ok: false,
      code: "not_ready",
      message: "Recording what your business paid is not set up on this deployment yet.",
    });
    mocks.recordActual.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await run(() => recordActualPayment(actor(), PAID))).toEqual({ ok: false, code: "failed", message: "That did not work. Try again in a moment." });
  });
});

describe("importActualPayments", () => {
  const CSV = `invoice,paid_date,amount,currency,reference\n${INVOICE},2026-10-09,100,USDC,BANK-1\n${OTHER},2026-10-09,30,USDC,\nINV-404,2026-10-09,5,,`;

  it("saves the matched rows, each as its own record, and lists the rows not saved with why", async () => {
    mocks.readMatchBills.mockResolvedValueOnce([bill(INVOICE), bill(OTHER, { current: record({ id: "rec-9", invoiceId: OTHER, amount: 25, currency: "USDC" }) })]);
    mocks.recordActual.mockResolvedValueOnce({ record: record(), corrected: false }).mockResolvedValueOnce({ record: record({ id: "rec-10" }), corrected: true });
    const outcome = await run(() => importActualPayments(actor(), { csv: CSV, today: "2026-10-10" }));
    expect(mocks.recordActual).toHaveBeenNthCalledWith(1, {
      actorId: USER,
      source: "csv",
      today: "2026-10-10",
      invoiceId: INVOICE,
      outcome: "paid",
      paidOn: "2026-10-09",
      amount: "100",
      currency: "USDC",
      method: "other",
      reference: "BANK-1",
      replaces: null,
    });
    expect(mocks.recordActual.mock.calls[1][0]).toMatchObject({ invoiceId: OTHER, replaces: "rec-9", amount: "30" });
    expect(outcome).toEqual({
      ok: true,
      message: "Saved 2 payments: 1 new, 1 correction. 1 row was not saved.",
      saved: 2,
      corrected: 1,
      same: 0,
      notSaved: [{ line: 4, invoice: "INV-404", why: "No payable carries that invoice number in its memo." }],
    });
  });

  it("skips a row the same as recorded, and keeps going when one row is refused", async () => {
    mocks.readMatchBills.mockResolvedValueOnce([
      bill(INVOICE, { current: record({ amount: 100, currency: "USDC", reference: "BANK-1", method: "other" }) }),
      bill(OTHER),
    ]);
    mocks.recordActual.mockRejectedValueOnce(new ActualPaymentError("changed"));
    const outcome = await run(() => importActualPayments(actor(), { csv: CSV, today: "2026-10-10" }));
    expect(mocks.recordActual).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      ok: false,
      code: "nothing_saved",
      message: "No payment was saved. 1 row was the same as recorded. 2 rows were not saved.",
    });
  });

  it("says why a file cannot be read, and that recording is not set up before migration 0090", async () => {
    expect(await run(() => importActualPayments(actor(), { csv: "invoice,amount\nA,1" }))).toEqual({ ok: false, code: "csv", message: "Missing CSV column: paid_date" });
    mocks.readMatchBills.mockRejectedValueOnce(new ActualPaymentError("not_ready"));
    expect(await run(() => importActualPayments(actor(), { csv: CSV }))).toMatchObject({ ok: false, code: "not_ready" });
  });
});
