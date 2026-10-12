import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { applyPayment, reverseAllocation } from "@/lib/allocations/apply";
import { AllocationError } from "@/lib/allocations/model";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Applying a payment and reversing it, written (docs/superpowers/specs/2026-10-12-allocations-design.md L5, L8, L12):
 * read now, planned, the signing key checked, every row in one insert with the version the person read, then one signed
 * entry per row; a refusal from the database reads in plain words; before 0103 runs it says so.
 */

const { ledgerMock, canSign } = vi.hoisted(() => ({ ledgerMock: vi.fn(), canSign: vi.fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));
vi.mock("@/lib/ledger", async (original) => ({ ...(await original<typeof import("@/lib/ledger")>()), assertLedgerCanSign: canSign }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a11";
const PERSON = "a1b2c3d4-0000-4000-8000-0000000000b1";
const PAYMENT = "018f8ce0-1557-7b54-a931-4d777f6ba900";
const [A, B, C] = ["018f8ce0-1557-7b54-a931-4d777f6ba00a", "018f8ce0-1557-7b54-a931-4d777f6ba00b", "018f8ce0-1557-7b54-a931-4d777f6ba00c"];
const TX = `0x${"ab".repeat(32)}`;
const FROM = "0x2222222222222222222222222222222222222222";
const MISSING = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.receivable_allocations' in the schema cache" } };

type Row = Record<string, unknown>;
const invoice = (id: string, amount: number, memo: string, over: Row = {}): Row => ({
  id,
  counterparty_id: "acme",
  amount,
  currency: "USDC",
  status: "pending",
  due_date: "2026-10-15T12:00:00+00:00",
  created_at: "2026-10-01T09:00:00+00:00",
  memo,
  po_reference: null,
  direction: "receivable",
  counterparties: { name: "Acme Corp" },
  ...over,
});
const PAYMENT_ROW = { id: PAYMENT, circle_tx_id: "circle-1", tx_hash: TX, from_address: FROM, amount: "900.000000", token: "USDC", received_at: "2026-10-12T09:00:00+00:00", invoice_id: null };

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: PERSON }), fn);

function workspace(over: { rows?: Row[]; allocations?: FakeReply; insert?: FakeReply; invoices?: Row[]; payment?: Row } = {}) {
  let inserted = 0;
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/incoming_transfers") {
      if (r.params.has("invoice_id")) return { body: [] };
      return { body: [over.payment ?? PAYMENT_ROW] };
    }
    if (r.path === "/rest/v1/receivable_allocations" && r.method === "GET") {
      if (over.allocations) return over.allocations;
      const rows = over.rows ?? [];
      const id = r.params.get("id")?.replace("eq.", "");
      return { body: id ? rows.filter((row) => row.id === id) : rows };
    }
    if (r.path === "/rest/v1/receivable_allocations" && r.method === "POST") {
      if (over.insert) return over.insert;
      return {
        status: 201,
        body: (r.body as Row[]).map((row) => {
          inserted += 1;
          return { id: `new-${inserted}`, created_at: "2026-10-12T10:00:00+00:00", ...row, payment_seq: row.payment_seq ?? (row.transfer_id ? inserted : null) };
        }),
      };
    }
    if (r.path === "/rest/v1/invoices") return { body: over.invoices ?? [invoice(A, 300, "Invoice INV-1"), invoice(B, 200, "Invoice INV-2"), invoice(C, 400, "Invoice INV-3")] };
    return { body: [] };
  };
}

const posts = () => fake.requests.filter((r) => r.path === "/rest/v1/receivable_allocations" && r.method === "POST");

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
  canSign.mockReset();
});

describe("applyPayment", () => {
  it("writes one payment across three receivables in one insert, numbered after the version read, then signs each row", async () => {
    fake = fakeSupabase(workspace());
    const result = await run(() =>
      applyPayment({
        actorId: PERSON,
        paymentId: PAYMENT,
        version: 0,
        lines: [
          { invoiceId: C, amount: "400" },
          { invoiceId: A, amount: "300.00" },
          { invoiceId: B, amount: "200" },
        ],
        fees: [],
        suggestion: { rule: "combination", why: "From Acme Corp's address on file, and it pays all three exactly: 900.00 USDC." },
      })
    );
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toEqual([
      { org_id: ORG, kind: "payment", invoice_id: A, transfer_id: PAYMENT, amount: 300, currency: "USDC", reason: null, basis: "person", reverses: null, payment_seq: 1, created_by: PERSON },
      { org_id: ORG, kind: "payment", invoice_id: B, transfer_id: PAYMENT, amount: 200, currency: "USDC", reason: null, basis: "person", reverses: null, payment_seq: 2, created_by: PERSON },
      { org_id: ORG, kind: "payment", invoice_id: C, transfer_id: PAYMENT, amount: 400, currency: "USDC", reason: null, basis: "person", reverses: null, payment_seq: 3, created_by: PERSON },
    ]);
    expect(canSign).toHaveBeenCalledTimes(1);
    expect(ledgerMock).toHaveBeenCalledTimes(3);
    const [orgId, entry] = ledgerMock.mock.calls[0];
    expect(orgId).toBe(ORG);
    expect(entry).toMatchObject({
      actor: "human",
      domain: "ar",
      action: "ar_payment_applied",
      summary: "Applied 300.00 USDC received on Arc testnet to Invoice INV-1 from Acme Corp (now paid)",
      detail: {
        by: PERSON,
        allocationId: "new-1",
        invoiceId: A,
        counterpartyId: "acme",
        transferId: PAYMENT,
        amount: 300,
        currency: "USDC",
        txHash: TX,
        from: FROM,
        basis: "person",
        outstandingAfter: 0,
        unappliedAfter: 0,
        suggestion: { rule: "combination" },
      },
    });
    const groups = new Set(ledgerMock.mock.calls.map(([, call]) => (call as { detail: { group: string } }).detail.group));
    expect(groups.size).toBe(1);
    expect(result).toMatchObject({ unappliedAfter: 0, customer: "Acme Corp" });
  });

  it("records a fee with its reason after the payment beside it, signed as a fee", async () => {
    fake = fakeSupabase(workspace({ payment: { ...PAYMENT_ROW, amount: "99.700000" }, invoices: [invoice(A, 100, "Invoice INV-1")] }));
    await run(() => applyPayment({ actorId: PERSON, paymentId: PAYMENT, version: 0, lines: [{ invoiceId: A, amount: "99.70" }], fees: [{ invoiceId: A, amount: "0.30", reason: "Transfer fee" }] }));
    expect((posts()[0].body as Row[]).map((row) => [row.kind, row.amount, row.reason])).toEqual([
      ["payment", 99.7, null],
      ["fee", 0.3, "Transfer fee"],
    ]);
    expect(ledgerMock.mock.calls[1][1]).toMatchObject({
      action: "ar_fee_recorded",
      summary: "Recorded 0.30 USDC as a fee on Invoice INV-1 from Acme Corp: Transfer fee (now paid)",
      detail: { reason: "Transfer fee", txHash: null, outstandingAfter: 0 },
    });
  });

  it("says applying payments is not set up yet before migration 0103, and writes nothing", async () => {
    fake = fakeSupabase(workspace({ allocations: MISSING }));
    await expect(run(() => applyPayment({ actorId: PERSON, paymentId: PAYMENT, version: 0, lines: [{ invoiceId: A, amount: "300" }], fees: [] }))).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(posts()).toHaveLength(0);
  });

  it("refuses a version that moved, and an amount it cannot read, before anything is written", async () => {
    fake = fakeSupabase(
      workspace({ rows: [{ id: "r-1", kind: "payment", invoice_id: A, transfer_id: PAYMENT, amount: "100", currency: "USDC", reverses: null, reason: null, basis: "person", payment_seq: 1, created_by: "x", created_at: "2026-10-12T09:30:00Z" }] })
    );
    await expect(run(() => applyPayment({ actorId: PERSON, paymentId: PAYMENT, version: 0, lines: [{ invoiceId: B, amount: "100" }], fees: [] }))).rejects.toMatchObject({ code: "stale" });
    await expect(run(() => applyPayment({ actorId: PERSON, paymentId: PAYMENT, version: 1, lines: [{ invoiceId: B, amount: "1.2.3" }], fees: [] }))).rejects.toMatchObject({ code: "amount" });
    expect(posts()).toHaveLength(0);
  });

  it("reads a refusal of the database in the same words, signing nothing", async () => {
    fake = fakeSupabase(workspace({ insert: { status: 400, body: { code: "P0001", message: "allocation_stale: the payment changed since it was read" } } }));
    const error = await run(() => applyPayment({ actorId: PERSON, paymentId: PAYMENT, version: 0, lines: [{ invoiceId: A, amount: "300" }], fees: [] })).catch((caught) => caught);
    expect(error).toBeInstanceOf(AllocationError);
    expect(error).toMatchObject({ code: "stale", message: "Someone applied this payment a moment ago. Reload the page to see what is left of it." });
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("refuses before the rows when the ledger cannot sign", async () => {
    fake = fakeSupabase(workspace());
    canSign.mockImplementation(() => {
      throw new Error("no signing key");
    });
    await expect(run(() => applyPayment({ actorId: PERSON, paymentId: PAYMENT, version: 0, lines: [{ invoiceId: A, amount: "300" }], fees: [] }))).rejects.toThrow("no signing key");
    expect(posts()).toHaveLength(0);
  });
});

describe("reverseAllocation", () => {
  it("appends the reversal with its reason, and signs it with what is owed after", async () => {
    const applied = { id: "r-1", kind: "payment", invoice_id: A, transfer_id: PAYMENT, amount: "300", currency: "USDC", reverses: null, reason: null, basis: "person", payment_seq: 1, created_by: "x", created_at: "2026-10-12T09:30:00Z" };
    fake = fakeSupabase(workspace({ rows: [applied], invoices: [invoice(A, 300, "Invoice INV-1", { status: "received" })] }));
    const result = await run(() => reverseAllocation({ actorId: PERSON, allocationId: "r-1", reason: "Wrong invoice" }));
    expect(posts()[0].body).toEqual([
      { org_id: ORG, kind: "reversal", invoice_id: A, transfer_id: PAYMENT, amount: 300, currency: "USDC", reason: "Wrong invoice", basis: null, reverses: "r-1", payment_seq: null, created_by: PERSON },
    ]);
    expect(ledgerMock.mock.calls[0][1]).toMatchObject({
      action: "ar_allocation_reversed",
      summary: "Reversed 300.00 USDC applied on Invoice INV-1 from Acme Corp: Wrong invoice (300.00 USDC still owed)",
      detail: { reverses: "r-1", reversedKind: "payment", invoiceId: A, amount: 300, reason: "Wrong invoice", outstandingAfter: 300, unappliedAfter: 900 },
    });
    expect(result).toMatchObject({ outstandingAfter: 300_000_000, label: "Invoice INV-1" });
  });

  it("refuses an unknown row and one reversed already", async () => {
    fake = fakeSupabase(workspace({ rows: [] }));
    await expect(run(() => reverseAllocation({ actorId: PERSON, allocationId: "nope", reason: "x" }))).rejects.toMatchObject({ code: "not_found" });
    fake = fakeSupabase(workspace({ insert: { status: 409, body: { code: "23505", message: 'duplicate key value violates unique constraint "receivable_allocations_one_reversal"' } }, rows: [{ id: "r-1", kind: "payment", invoice_id: A, transfer_id: PAYMENT, amount: "300", currency: "USDC", reverses: null, reason: null, basis: "person", payment_seq: 1, created_by: "x", created_at: "2026-10-12T09:30:00Z" }] }));
    await expect(run(() => reverseAllocation({ actorId: PERSON, allocationId: "r-1", reason: "x" }))).rejects.toMatchObject({ code: "already_reversed" });
  });
});
