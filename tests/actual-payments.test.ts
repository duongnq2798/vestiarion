import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { ActualPaymentError, readActualsFacts, recordActual } from "@/lib/actual-payments";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Recording what the business paid outside Vestiarion (docs/superpowers/specs/2026-10-10-actual-payments-design.md A1–A3,
 * A10): checked, kept as a row, then signed into the ledger; a correction names the newest record and appends to it;
 * before migration 0090 runs, it says so instead of failing.
 */

const { ledgerMock, canSign } = vi.hoisted(() => ({ ledgerMock: vi.fn(), canSign: vi.fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));
vi.mock("@/lib/ledger", async (original) => ({ ...(await original<typeof import("@/lib/ledger")>()), assertLedgerCanSign: canSign }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a01";
const PERSON = "a1b2c3d4-0000-4000-8000-0000000000a1";
const INVOICE = "018f8ce0-1557-7b54-a931-4d777f6ba001";
const TODAY = "2026-10-10";
const MISSING = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.payment_actuals' in the schema cache" } };

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: PERSON }), fn);

type Row = Record<string, unknown>;
function workspace(over: { invoice?: Row | null; records?: Row[]; insert?: FakeReply; actuals?: FakeReply } = {}) {
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/invoices") return { body: over.invoice === null ? [] : [over.invoice ?? { id: INVOICE, direction: "payable", currency: "USDC", original_currency: null }] };
    if (r.path === "/rest/v1/payment_actuals" && r.method === "GET") return over.actuals ?? { body: over.records ?? [] };
    if (r.path === "/rest/v1/payment_actuals" && r.method === "POST") {
      if (over.insert) return over.insert;
      const body = r.body as Row;
      return { status: 201, body: { id: "rec-new", recorded_at: "2026-10-10T08:00:00.000Z", ...body } };
    }
    return { body: [] };
  };
}

const PAID = { invoiceId: INVOICE, outcome: "paid" as const, paidOn: "2026-10-09", amount: "1,250.00", currency: "eur", method: "bank_transfer", reference: " BANK-2207 ", note: "" };
const posted = () => fake.requests.filter((r) => r.path === "/rest/v1/payment_actuals" && r.method === "POST");

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
  canSign.mockReset();
});

describe("recordActual", () => {
  it("keeps a paid record, then signs it into the ledger with the payable as its subject", async () => {
    fake = fakeSupabase(workspace());
    const result = await run(() => recordActual({ actorId: PERSON, today: TODAY, source: "form", ...PAID }));
    expect(posted()[0].body).toEqual({
      org_id: ORG,
      invoice_id: INVOICE,
      outcome: "paid",
      paid_on: "2026-10-09",
      amount: 1250,
      currency: "EUR",
      method: "bank_transfer",
      reference: "BANK-2207",
      note: null,
      reason: null,
      replaces: null,
      source: "form",
      recorded_by: PERSON,
    });
    expect(result).toMatchObject({ corrected: false, record: { id: "rec-new", outcome: "paid", amount: 1250, currency: "EUR", paidOn: "2026-10-09" } });
    expect(ledgerMock).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "ap",
      action: "actual_payment_recorded",
      summary: "Recorded what the business paid outside Vestiarion: 1,250.00 EUR on 2026-10-09 by bank transfer",
      detail: {
        by: PERSON,
        actualId: "rec-new",
        subject: "invoice",
        subjectId: INVOICE,
        outcome: "paid",
        paidOn: "2026-10-09",
        amount: 1250,
        currency: "EUR",
        method: "bank_transfer",
        reference: "BANK-2207",
        note: null,
        reason: null,
      },
    });
    // The key that signs it is checked before the row is written.
    expect(canSign).toHaveBeenCalled();
  });

  it("keeps a not-paid record with its reason, and names a CSV row as one", async () => {
    fake = fakeSupabase(workspace());
    await run(() => recordActual({ actorId: PERSON, today: TODAY, source: "csv", invoiceId: INVOICE, outcome: "not_paid", reason: "The supplier sent a credit note" }));
    expect(posted()[0].body).toMatchObject({ outcome: "not_paid", paid_on: null, amount: null, currency: null, method: null, reason: "The supplier sent a credit note", source: "csv" });
    expect(ledgerMock.mock.calls[0][1]).toMatchObject({
      summary: "Recorded that the business did not pay it: The supplier sent a credit note",
      detail: { outcome: "not_paid", reason: "The supplier sent a credit note", via: "csv" },
    });
  });

  it("appends a correction to the newest record, and refuses one of a record corrected since", async () => {
    const records = [
      { id: "rec-1", replaces: null },
      { id: "rec-2", replaces: "rec-1" },
    ];
    fake = fakeSupabase(workspace({ records }));
    const result = await run(() => recordActual({ actorId: PERSON, today: TODAY, source: "form", ...PAID, replaces: "rec-2" }));
    expect(result.corrected).toBe(true);
    expect(posted()[0].body).toMatchObject({ replaces: "rec-2" });
    expect(ledgerMock.mock.calls[0][1]).toMatchObject({ action: "actual_payment_corrected", detail: { replaces: "rec-2" } });

    fake = fakeSupabase(workspace({ records }));
    await expect(run(() => recordActual({ actorId: PERSON, today: TODAY, source: "form", ...PAID, replaces: "rec-1" }))).rejects.toMatchObject({ code: "not_current" });
    await expect(run(() => recordActual({ actorId: PERSON, today: TODAY, source: "form", ...PAID }))).rejects.toMatchObject({ code: "already_recorded" });
    expect(posted()).toHaveLength(0);
  });

  it("says someone recorded it a moment before when the one-line history refuses the row", async () => {
    fake = fakeSupabase(workspace({ insert: { status: 409, body: { code: "23505", message: "duplicate key value violates unique constraint \"payment_actuals_first_per_invoice\"" } } }));
    await expect(run(() => recordActual({ actorId: PERSON, today: TODAY, source: "form", ...PAID }))).rejects.toMatchObject({ code: "changed" });
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("checks every field before anything is read or written", async () => {
    fake = fakeSupabase(workspace());
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ paidOn: "2026-10-12" }, "paid_day"],
      [{ paidOn: "" }, "paid_day"],
      [{ amount: "0" }, "amount"],
      [{ amount: "12.3456" }, "amount"],
      [{ currency: "dollars" }, "currency"],
      [{ method: "cheque" }, "method"],
      [{ reference: "r".repeat(141) }, "reference_too_long"],
      [{ note: "n".repeat(281) }, "note_too_long"],
    ];
    for (const [change, code] of cases) {
      await expect(run(() => recordActual({ actorId: PERSON, today: TODAY, source: "form", ...PAID, ...change }))).rejects.toMatchObject({ code });
    }
    await expect(run(() => recordActual({ actorId: PERSON, today: TODAY, source: "form", invoiceId: INVOICE, outcome: "not_paid", reason: " " }))).rejects.toMatchObject({ code: "reason_required" });
    await expect(run(() => recordActual({ actorId: PERSON, today: TODAY, source: "form", invoiceId: INVOICE, outcome: "not_paid", reason: "x".repeat(281) }))).rejects.toMatchObject({
      code: "reason_too_long",
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("takes a bill in a currency with no cents as a whole amount", async () => {
    fake = fakeSupabase(workspace());
    await run(() => recordActual({ actorId: PERSON, today: TODAY, source: "form", ...PAID, currency: "JPY", amount: "150,000" }));
    expect(posted()[0].body).toMatchObject({ amount: 150000, currency: "JPY" });
  });

  it("is only for a payable of this workspace", async () => {
    fake = fakeSupabase(workspace({ invoice: null }));
    await expect(run(() => recordActual({ actorId: PERSON, today: TODAY, source: "form", ...PAID }))).rejects.toMatchObject({ code: "not_a_payable" });
    fake = fakeSupabase(workspace({ invoice: { id: INVOICE, direction: "receivable" } }));
    await expect(run(() => recordActual({ actorId: PERSON, today: TODAY, source: "form", ...PAID }))).rejects.toMatchObject({ code: "not_a_payable" });
    expect(posted()).toHaveLength(0);
    // Read inside the workspace's scope.
    expect(fake.requests.find((r) => r.path === "/rest/v1/invoices")?.params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("says recording is not set up yet when migration 0090 has not run", async () => {
    fake = fakeSupabase(workspace({ actuals: MISSING }));
    const refused = run(() => recordActual({ actorId: PERSON, today: TODAY, source: "form", ...PAID }));
    await expect(refused).rejects.toBeInstanceOf(ActualPaymentError);
    await expect(run(() => recordActual({ actorId: PERSON, today: TODAY, source: "form", ...PAID }))).rejects.toMatchObject({
      code: "not_ready",
      message: "Recording what your business paid is not set up on this deployment yet.",
    });
  });
});

describe("readActualsFacts", () => {
  it("reads the records, the entries that recorded them and each verdict's entry", async () => {
    fake = fakeSupabase((r) => {
      if (r.path === "/rest/v1/payment_actuals") {
        return {
          body: [
            {
              id: "rec-1",
              invoice_id: INVOICE,
              outcome: "paid",
              paid_on: "2026-10-09",
              amount: "1250.000000",
              currency: "EUR",
              method: "card",
              reference: null,
              note: null,
              reason: null,
              replaces: null,
              source: "form",
              recorded_by: PERSON,
              recorded_at: "2026-10-10T08:00:00+00:00",
            },
          ],
        };
      }
      if (r.path === "/rest/v1/ledger_entries" && r.params.get("action") === "eq.decision_verdict") return { body: [{ seq: 12, entry_seq: "7" }] };
      if (r.path === "/rest/v1/ledger_entries") return { body: [{ seq: 31, actual_id: "rec-1" }] };
      return { body: [] };
    });
    const read = await run(() => readActualsFacts(db()));
    expect(read.available).toBe(true);
    if (!read.available) return;
    expect(read.facts.records).toEqual([
      {
        id: "rec-1",
        invoiceId: INVOICE,
        outcome: "paid",
        paidOn: "2026-10-09",
        amount: 1250,
        currency: "EUR",
        method: "card",
        reference: null,
        note: null,
        reason: null,
        replaces: null,
        source: "form",
        recordedBy: PERSON,
        recordedAt: "2026-10-10T08:00:00+00:00",
      },
    ]);
    expect(read.facts.entries).toEqual(new Map([["rec-1", 31]]));
    expect(read.facts.verdictEntries).toEqual(new Map([[7, 12]]));
  });

  it("reads as not set up, rather than failing the report, when migration 0090 has not run", async () => {
    fake = fakeSupabase((r) => (r.path === "/rest/v1/payment_actuals" ? MISSING : { body: [] }));
    expect(await run(() => readActualsFacts(db()))).toEqual({ available: false });
  });
});
