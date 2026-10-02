import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { createRecurringPayable, listRecurringPayables, RecurringPayableError, stopRecurringPayable } from "@/lib/recurring-payables";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Setting up and stopping recurring payments (docs/superpowers/specs/2026-10-02-recurring-payables-design.md
 * §2, R5): to a vendor or contractor of the workspace only, each change signed by the person.
 */

const { ledgerMock } = vi.hoisted(() => ({ ledgerMock: vi.fn() }));
vi.mock("@/lib/ledger", () => ({ appendLedgerEntry: ledgerMock }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f0f";
const ACTOR = "a1b2c3d4-0000-4000-8000-000000000004";
const CP = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";

const FORM = {
  counterpartyId: CP,
  amount: "25",
  currency: "USDC" as const,
  memo: "Weekly retainer",
  poReference: "PO-77",
  everyCount: 1,
  everyUnit: "week" as const,
  startsOn: "2026-10-05",
  endsOn: null,
  goodsReceived: true,
};

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: ACTOR }), fn);

function workspace(over: { role?: string | null; schedule?: unknown; stopped?: unknown[]; list?: unknown[] } = {}) {
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/counterparties") return { body: over.role === null ? null : { id: CP, name: "Linh Design", role: over.role ?? "contractor" } };
    if (r.path === "/rest/v1/recurring_payables" && r.method === "POST") return { status: 201, body: { id: "rec-1" } };
    if (r.path === "/rest/v1/recurring_payables" && r.method === "PATCH") return { body: over.stopped ?? [{ id: "rec-1" }] };
    if (r.path === "/rest/v1/recurring_payables" && r.method === "GET") {
      return r.params.has("id") ? { body: over.schedule === undefined ? { id: "rec-1", status: "active", counterparties: { name: "Linh Design" } } : over.schedule } : { body: over.list ?? [] };
    }
    return { body: [] };
  };
}

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
});

describe("createRecurringPayable", () => {
  it("records the schedule as the person's, and signs it", async () => {
    fake = fakeSupabase(workspace());
    expect(await run(() => createRecurringPayable({ actorId: ACTOR, form: FORM }))).toEqual({ id: "rec-1", counterpartyName: "Linh Design", cadence: "every week" });
    const post = fake.requests.find((r) => r.path === "/rest/v1/recurring_payables" && r.method === "POST")!;
    expect(post.body).toEqual({
      org_id: ORG,
      counterparty_id: CP,
      amount: "25",
      currency: "USDC",
      memo: "Weekly retainer",
      po_reference: "PO-77",
      goods_received: true,
      every_count: 1,
      every_unit: "week",
      starts_on: "2026-10-05",
      ends_on: null,
      created_by: ACTOR,
    });
    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "human",
        domain: "ap",
        action: "recurring_payable_created",
        summary: "Set up a recurring payment to Linh Design: 25 USDC every week from 2026-10-05",
      })
    );
  });

  it("refuses a client, and a counterparty that is not the workspace's", async () => {
    fake = fakeSupabase(workspace({ role: "client" }));
    await expect(run(() => createRecurringPayable({ actorId: ACTOR, form: FORM }))).rejects.toMatchObject({ code: "client" });
    fake = fakeSupabase(workspace({ role: null }));
    await expect(run(() => createRecurringPayable({ actorId: ACTOR, form: FORM }))).rejects.toBeInstanceOf(RecurringPayableError);
    expect(ledgerMock).not.toHaveBeenCalled();
  });
});

describe("stopRecurringPayable", () => {
  it("stops a running schedule compare-and-set, and signs it", async () => {
    fake = fakeSupabase(workspace());
    expect(await run(() => stopRecurringPayable({ actorId: ACTOR, id: "rec-1" }))).toEqual({ counterpartyName: "Linh Design" });
    const patch = fake.requests.find((r) => r.method === "PATCH")!;
    expect(patch.params.get("status")).toBe("eq.active");
    expect(patch.body).toMatchObject({ status: "stopped", stopped_by: ACTOR });
    expect(ledgerMock).toHaveBeenCalledWith(expect.objectContaining({ action: "recurring_payable_stopped", detail: { by: ACTOR, recurringId: "rec-1" } }));
  });

  it("says when it had already stopped, or was not found", async () => {
    fake = fakeSupabase(workspace({ stopped: [] }));
    await expect(run(() => stopRecurringPayable({ actorId: ACTOR, id: "rec-1" }))).rejects.toMatchObject({ code: "not_active" });
    fake = fakeSupabase(workspace({ schedule: null }));
    await expect(run(() => stopRecurringPayable({ actorId: ACTOR, id: "rec-1" }))).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("listRecurringPayables", () => {
  it("shows each schedule's cadence and next due date, the running ones first", async () => {
    const row = { amount: "25.000000", currency: "USDC", memo: "Weekly retainer", every_count: 1, every_unit: "week", starts_on: "2026-10-05", ends_on: null, counterparties: { name: "Linh Design" } };
    fake = fakeSupabase(workspace({ list: [{ ...row, id: "old", next_period: 3, status: "stopped" }, { ...row, id: "rec-1", next_period: 2, status: "active" }] }));
    const views = await run(() => listRecurringPayables());
    expect(views.map((view) => [view.id, view.status, view.cadence, view.nextDueOn])).toEqual([
      ["rec-1", "active", "every week", "2026-10-19"],
      ["old", "stopped", "every week", null],
    ]);
  });
});
