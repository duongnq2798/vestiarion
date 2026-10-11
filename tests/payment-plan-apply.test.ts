import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { PlanLine } from "@/lib/payment-plan";
import { moveScheduledPayment } from "@/lib/payment-plan-apply";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * Moving a scheduled bill to the plan's day (payment plan design P9): one compare-and-set on what the line showed, and
 * the signed entry that says who moved it, from where to where. Nothing else is written; nothing is paid.
 */

const { ledgerMock } = vi.hoisted(() => ({ ledgerMock: vi.fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c21";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c5";
const INVOICE = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f9";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const line: PlanLine = {
  id: INVOICE,
  kind: "bill",
  payee: "Northwind Supply",
  counterpartyId: "c-1",
  title: null,
  amount: 1000,
  status: "scheduled",
  state: "planned",
  dueOn: "2026-10-22",
  agentOn: "2026-10-22",
  on: "2026-10-15",
  inWindow: true,
  pays: 980,
  discount: { pct: 2, value: 20, until: "2026-10-15", taken: true },
  reason: "Pays on Oct 15, 2026, the discount's last day.",
  flags: [],
  balanceAfter: 1020,
  agentPays: true,
  move: { from: "2026-10-22", to: "2026-10-15" },
  approvable: true,
  createdBy: "u-maker",
  fingerprint: "line-fp",
};

function run(changed: boolean) {
  const fake = fakeSupabase((request) => (request.method === "PATCH" ? { body: changed ? [{ id: INVOICE }] : [] } : { body: [] }));
  const result = runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () =>
    moveScheduledPayment({ actorId: USER, line, planFingerprint: "plan-fp", soleApprover: false })
  );
  return { result, requests: fake.requests };
}

const patchOf = (requests: RecordedRequest[]) => requests.find((request) => request.method === "PATCH")!;

beforeEach(() => ledgerMock.mockReset());

describe("moveScheduledPayment", () => {
  it("moves the day only while the bill is still scheduled on the day shown, for the amount, payee and due date shown", async () => {
    const { result, requests } = run(true);
    expect(await result).toBe(true);
    expect(requests.filter((request) => request.method !== "GET")).toHaveLength(1);
    const patch = patchOf(requests);
    expect(patch.path).toBe("/rest/v1/invoices");
    expect(patch.body).toEqual({ scheduled_for: "2026-10-15T00:00:00.000Z" });
    expect(patch.params.get("id")).toBe(`eq.${INVOICE}`);
    expect(patch.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(patch.params.get("direction")).toBe("eq.payable");
    expect(patch.params.get("status")).toBe("eq.scheduled");
    expect(patch.params.get("counterparty_id")).toBe("eq.c-1");
    expect(patch.params.get("amount")).toBe("eq.1000");
    expect(patch.params.getAll("scheduled_for")).toEqual(["gte.2026-10-22T00:00:00.000Z", "lt.2026-10-23T00:00:00.000Z"]);
    expect(patch.params.getAll("due_date")).toEqual(["gte.2026-10-22T00:00:00.000Z", "lt.2026-10-23T00:00:00.000Z"]);
  });

  it("records who moved it, from where to where, and the facts the line showed, in a signed entry", async () => {
    await run(true).result;
    expect(ledgerMock).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "ap",
      action: "payment_rescheduled",
      summary: "Moved the payment to Northwind Supply for 1000 USDC from 2026-10-22 to 2026-10-15, from the payment plan",
      detail: {
        by: USER,
        invoiceId: INVOICE,
        counterpartyId: "c-1",
        from: "2026-10-22",
        to: "2026-10-15",
        dueOn: "2026-10-22",
        amount: 1000,
        pays: 980,
        discount: { pct: 2, value: 20, until: "2026-10-15" },
        balanceAfter: 1020,
        planFingerprint: "plan-fp",
        lineFingerprint: "line-fp",
      },
    });
  });

  it("says the person entered it themselves, as the only approver, when they did", async () => {
    const fake = fakeSupabase((request) => (request.method === "PATCH" ? { body: [{ id: INVOICE }] } : { body: [] }));
    await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () =>
      moveScheduledPayment({ actorId: USER, line, planFingerprint: "plan-fp", soleApprover: true })
    );
    expect(ledgerMock.mock.calls[0][1].detail).toMatchObject({ soleApprover: true });
  });

  it("writes no entry when the bill changed in between", async () => {
    const { result } = run(false);
    expect(await result).toBe(false);
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("refuses a line with nothing to move without writing anything", async () => {
    const fake = fakeSupabase();
    const moved = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () =>
      moveScheduledPayment({ actorId: USER, line: { ...line, move: null }, planFingerprint: "plan-fp", soleApprover: false })
    );
    expect(moved).toBe(false);
    expect(fake.requests).toEqual([]);
  });
});
