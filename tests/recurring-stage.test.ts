import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { createRecurringInvoices } from "@/lib/agent/recurring";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The cycle's recurring stage (docs/superpowers/specs/2026-10-02-recurring-payables-design.md R1–R5):
 * each period's invoice as it comes near, created once with the schedule's terms and maker, the
 * schedule advanced compare-and-set, each signed; a schedule past its last due date ends.
 */

const { ledgerMock } = vi.hoisted(() => ({ ledgerMock: vi.fn() }));
vi.mock("@/lib/ledger", () => ({ appendLedgerEntry: ledgerMock }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e0e";
const MAKER = "a1b2c3d4-0000-4000-8000-000000000003";

const SCHEDULE = {
  id: "rec-1",
  counterparty_id: "cp-1",
  amount: "25.000000",
  currency: "USDC",
  memo: "Weekly retainer",
  po_reference: "PO-77",
  goods_received: true,
  every_count: 1,
  every_unit: "week",
  starts_on: "2026-10-05",
  ends_on: null,
  next_period: 0,
  created_by: MAKER,
  counterparties: { name: "Linh Design" },
};

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);

function workspace(schedules: unknown[], insert: (r: RecordedRequest) => FakeReply = () => ({ status: 201, body: { id: "inv-new" } })) {
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/recurring_payables" && r.method === "GET") return { body: schedules };
    if (r.path === "/rest/v1/invoices" && r.method === "POST") return insert(r);
    if (r.path === "/rest/v1/recurring_payables" && r.method === "PATCH") return { status: 200, body: null };
    return { body: [] };
  };
}
const posts = () => fake.requests.filter((r) => r.path === "/rest/v1/invoices" && r.method === "POST");
const patches = () => fake.requests.filter((r) => r.path === "/rest/v1/recurring_payables" && r.method === "PATCH");

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
});

describe("createRecurringInvoices", () => {
  it("creates nothing before a period is near", async () => {
    fake = fakeSupabase(workspace([SCHEDULE]));
    expect(await run(() => createRecurringInvoices(db(), new Date("2026-09-28T09:00:00Z")))).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("creates the period's invoice with the schedule's terms and maker, advances it, and signs it", async () => {
    fake = fakeSupabase(workspace([SCHEDULE]));
    const lines = await run(() => createRecurringInvoices(db(), new Date("2026-09-29T09:00:00Z")));

    expect(posts().map((r) => r.body)).toEqual([
      {
        org_id: ORG,
        direction: "payable",
        counterparty_id: "cp-1",
        amount: "25.000000",
        currency: "USDC",
        memo: "Weekly retainer (Oct 5, 2026)",
        po_reference: "PO-77",
        goods_received: true,
        due_date: "2026-10-05T12:00:00.000Z",
        created_by: MAKER,
        recurring_id: "rec-1",
        recurring_period: "2026-10-05",
      },
    ]);
    const advance = patches()[0];
    expect(advance.body).toEqual({ next_period: 1 });
    expect(advance.params.get("next_period")).toBe("eq.0");
    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "agent",
        domain: "ap",
        action: "recurring_invoice_created",
        detail: { invoiceId: "inv-new", recurringId: "rec-1", period: "2026-10-05", counterpartyId: "cp-1", amount: 25, currency: "USDC", goodsReceived: true },
      })
    );
    expect(lines).toEqual([{ domain: "ap", message: "Linh Design: created the Oct 5, 2026 invoice of a recurring payment (25 USDC)" }]);
  });

  it("moves past a period an earlier cycle already created, without a second entry (R1)", async () => {
    fake = fakeSupabase(workspace([SCHEDULE], () => ({ status: 409, body: { code: "23505", message: 'duplicate key value violates unique constraint "invoices_recurring_period_key"' } })));
    const lines = await run(() => createRecurringInvoices(db(), new Date("2026-09-29T09:00:00Z")));
    expect(patches()[0].body).toEqual({ next_period: 1 });
    expect(ledgerMock).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it("throws on any other failure, so the stage says it failed", async () => {
    fake = fakeSupabase(workspace([SCHEDULE], () => ({ status: 500, body: { message: "connection reset" } })));
    await expect(run(() => createRecurringInvoices(db(), new Date("2026-09-29T09:00:00Z")))).rejects.toThrow("connection reset");
  });

  it("ends a schedule past its last due date", async () => {
    fake = fakeSupabase(workspace([{ ...SCHEDULE, every_unit: "day", starts_on: "2026-10-01", ends_on: "2026-10-02", next_period: 2 }]));
    const lines = await run(() => createRecurringInvoices(db(), new Date("2026-10-03T09:00:00Z")));
    expect(posts()).toEqual([]);
    expect(patches()[0].body).toEqual({ status: "ended" });
    expect(lines).toEqual([{ domain: "ap", message: "Linh Design: a recurring payment reached its last due date and ended" }]);
  });

  it("reads only active schedules", async () => {
    fake = fakeSupabase(workspace([]));
    await run(() => createRecurringInvoices(db(), new Date("2026-10-03T09:00:00Z")));
    expect(fake.requests[0].params.get("status")).toBe("eq.active");
  });
});
