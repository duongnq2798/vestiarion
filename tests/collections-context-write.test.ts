import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { resolveCollectionTaskCommand, setCollectionPolicy } from "@/lib/commands/collections";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import { CustomerRequestError } from "@/lib/customer-portal/requests";
import { deliveryKey, recipientHash } from "@/lib/notifications/deliveries";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * What a person changes about collections (docs/superpowers/specs/2026-10-13-collections-context-design.md C4, C6): a
 * customer's rules saved as the next version over the one shown, and a collection task resolved once with what its
 * outcome needs. Both are `records.write`, from the console only, gated before anything is read.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { ledger: vi.fn(), setReminders: vi.fn(), close: vi.fn() } }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: mocks.ledger }));
vi.mock("@/lib/platform/pay-links", async (original) => ({ ...(await original<typeof import("@/lib/platform/pay-links")>()), setReminders: mocks.setReminders }));
vi.mock("@/lib/customer-portal/requests", async (original) => ({ ...(await original<typeof import("@/lib/customer-portal/requests")>()), closeCustomerRequest: mocks.close }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d1";
const ADMIN = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d2";
const VIEWER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d3";
const CUSTOMER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000dc";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d9";
const TASK = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000da";
const NOW = Date.parse("2026-10-20T09:00:00Z");
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const actor = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "owner", mode: "live", surface: { kind: "console" }, ...fields });

const taskRow = (over: Record<string, unknown> = {}) => ({
  id: TASK,
  invoice_id: INVOICE,
  counterparty_id: CUSTOMER,
  kind: "ask_owner",
  reason: "policy_ask_first",
  subject_key: "policy:2:reminder:1",
  assignee: USER,
  policy_version: 2,
  proposal: { headline: "Ask", reasons: [], reminder: { number: 1, tone: "firm", tones: ["friendly", "firm"], channel: "email", daysFromDue: 5, owed: 1000, received: 0 } },
  status: "open",
  outcome: null,
  hold_until: null,
  approved_number: null,
  approved_tone: null,
  resolved_at: null,
  resolved_by: null,
  notified_at: null,
  created_at: "2026-10-19T09:00:00Z",
  ...over,
});

interface World {
  role?: string;
  latest?: number;
  insert?: FakeReply;
  task?: Record<string, unknown> | null;
  resolved?: unknown[];
}

function world(w: World = {}) {
  return fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path === "/rest/v1/counterparties") return { body: [{ id: CUSTOMER, name: "Acme", role: w.role ?? "client" }] };
    if (request.path === "/rest/v1/rpc/org_members") {
      return {
        body: [
          { user_id: USER, email: "owner@mai.example", role: "owner", joined_at: "2026-09-01T00:00:00Z" },
          { user_id: ADMIN, email: "admin@mai.example", role: "admin", joined_at: "2026-09-01T00:00:00Z" },
          { user_id: VIEWER, email: "viewer@mai.example", role: "viewer", joined_at: "2026-09-01T00:00:00Z" },
        ],
      };
    }
    if (request.path === "/rest/v1/collection_policies" && request.method === "GET") {
      return { body: w.latest ? [{ id: "p", counterparty_id: CUSTOMER, version: w.latest, approval: "auto", max_tone: "final", min_days_between: 3, channel: "email", account_owner: null, created_by: USER, created_at: "2026-10-01T00:00:00Z" }] : [] };
    }
    if (request.path === "/rest/v1/collection_policies" && request.method === "POST") return w.insert ?? { body: { id: "policy-new", created_at: "2026-10-20T09:00:00Z" } };
    if (request.path === "/rest/v1/collection_tasks" && request.method === "GET") return { body: w.task === null ? [] : [w.task ?? taskRow()] };
    if (request.path === "/rest/v1/collection_tasks" && request.method === "PATCH") return { body: w.resolved ?? [{ id: TASK }] };
    return { body: [] };
  });
}

const run = <T,>(client: ReturnType<typeof world>, fn: () => Promise<T>) => runWith(orgTestContext({ config, client: client.client, orgId: ORG }), fn);
const rules = (over: Record<string, unknown> = {}) => ({ counterpartyId: CUSTOMER, approval: "ask_first", maxTone: "firm", minDaysBetween: 7, accountOwner: ADMIN, expectedVersion: 0, ...over });

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.setReminders.mockResolvedValue({ madeNewLink: false, replacedLink: false, counterpartyName: "Acme" });
  mocks.close.mockResolvedValue({ customerName: "Acme", kind: "promise" });
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("who may change collections", () => {
  it("is the permission that turns reminders on, from the console only", () => {
    for (const name of ["collection_policy.set", "collection_task.resolve"] as const) {
      expect(COMMAND_PERMISSIONS[name]).toBe("records.write");
      for (const surface of ["api", "slack", "telegram", "github"] as const) expect(SURFACE_COMMANDS[surface]).not.toContain(name);
    }
  });

  it.each(["approver", "viewer", "accountant"] as const)("refuses an %s before anything is read: rules and tasks decide what a customer is sent", async (role) => {
    const client = world();
    expect(await run(client, () => setCollectionPolicy(actor({ role }), rules()))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(client, () => resolveCollectionTaskCommand(actor({ role }), { taskId: TASK, outcome: "approved" }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(client.requests).toHaveLength(0);
  });
});

describe("a customer's rules (C4)", () => {
  it("saves the next version over the one shown, and signs it", async () => {
    const client = world({ latest: 1 });
    expect(await run(client, () => setCollectionPolicy(actor(), rules({ expectedVersion: 1 })))).toEqual({
      ok: true,
      message: "Saved Acme's rules as version 2. The agent follows them from its next cycle.",
      version: 2,
    });
    const insert = client.requests.find((r) => r.path === "/rest/v1/collection_policies" && r.method === "POST");
    expect(insert?.body).toEqual({ org_id: ORG, counterparty_id: CUSTOMER, version: 2, approval: "ask_first", max_tone: "firm", min_days_between: 7, channel: "email", account_owner: ADMIN, created_by: USER });
    expect(mocks.ledger).toHaveBeenCalledWith(ORG, expect.objectContaining({ actor: "human", action: "collection_policy_set", detail: expect.objectContaining({ counterpartyId: CUSTOMER, version: 2, approval: "ask_first", by: USER }) }));
  });

  it("refuses a version saved since, rules out of bounds, a vendor, and an account owner who cannot act", async () => {
    expect(await run(world({ latest: 2 }), () => setCollectionPolicy(actor(), rules({ expectedVersion: 1 })))).toMatchObject({ ok: false, code: "changed", changed: true });
    expect(await run(world(), () => setCollectionPolicy(actor(), rules({ minDaysBetween: 2 })))).toMatchObject({ ok: false, code: "rules" });
    expect(await run(world(), () => setCollectionPolicy(actor(), rules({ maxTone: "angry" })))).toMatchObject({ ok: false, code: "rules" });
    expect(await run(world({ role: "vendor" }), () => setCollectionPolicy(actor(), rules()))).toMatchObject({ ok: false, code: "not_client" });
    expect(await run(world(), () => setCollectionPolicy(actor(), rules({ accountOwner: VIEWER })))).toMatchObject({ ok: false, code: "owner" });
    // Two people saving at once: the database's unique version refuses the second.
    expect(await run(world({ insert: { status: 409, body: { code: "23505", message: "duplicate key value violates unique constraint" } } }), () => setCollectionPolicy(actor(), rules()))).toMatchObject({
      ok: false,
      code: "changed",
    });
    expect(mocks.ledger).not.toHaveBeenCalled();
  });
});

describe("resolving a task (C6)", () => {
  it("approves the drafted reminder at a tone it offered, and starts a cycle", async () => {
    const client = world();
    expect(await run(client, () => resolveCollectionTaskCommand(actor(), { taskId: TASK, outcome: "approved", tone: "friendly" }))).toEqual({
      ok: true,
      message: "Approved reminder 1 to Acme, friendly. The agent sends it within a minute, if nothing changed since.",
      startsCycle: true,
    });
    const update = client.requests.find((r) => r.path === "/rest/v1/collection_tasks" && r.method === "PATCH");
    expect(update?.params.get("status")).toBe("eq.open");
    expect(update?.body).toMatchObject({ status: "done", outcome: "approved", approved_number: 1, approved_tone: "friendly", hold_until: null, resolved_by: USER });
    expect(mocks.ledger).toHaveBeenCalledWith(ORG, expect.objectContaining({ action: "collection_task_resolved", detail: expect.objectContaining({ taskId: TASK, outcome: "approved", reminder: { number: 1, tone: "friendly" } }) }));
  });

  it("refuses a tone the draft did not offer, a hold day out of range, and an outcome the task does not take", async () => {
    expect(await run(world(), () => resolveCollectionTaskCommand(actor(), { taskId: TASK, outcome: "approved", tone: "final" }))).toMatchObject({ ok: false, code: "tone" });
    expect(await run(world(), () => resolveCollectionTaskCommand(actor(), { taskId: TASK, outcome: "held", holdUntil: "2026-10-20" }))).toMatchObject({ ok: false, code: "hold" });
    expect(await run(world(), () => resolveCollectionTaskCommand(actor(), { taskId: TASK, outcome: "held", holdUntil: "2027-01-01" }))).toMatchObject({ ok: false, code: "hold" });
    expect(await run(world(), () => resolveCollectionTaskCommand(actor(), { taskId: TASK, outcome: "resumed" }))).toMatchObject({ ok: false, code: "outcome" });
    expect(mocks.ledger).not.toHaveBeenCalled();
  });

  it("holds reminders until a day", async () => {
    const client = world();
    expect(await run(client, () => resolveCollectionTaskCommand(actor(), { taskId: TASK, outcome: "held", holdUntil: "2026-11-02" }))).toMatchObject({
      ok: true,
      message: "Reminders to Acme about this invoice wait until Nov 2, 2026.",
      startsCycle: false,
    });
    expect(client.requests.find((r) => r.method === "PATCH")?.body).toMatchObject({ outcome: "held", hold_until: "2026-11-02" });
  });

  it("turns the invoice's reminders off for no reminders", async () => {
    await run(world(), () => resolveCollectionTaskCommand(actor(), { taskId: TASK, outcome: "no_reminder" }));
    expect(mocks.setReminders).toHaveBeenCalledWith({ actorId: USER, invoiceId: INVOICE, on: false });
  });

  it("closes a broken promise before letting reminders go again, even one closed already", async () => {
    const promise = taskRow({ kind: "finance_review", reason: "promise_passed", subject_key: "promise:req-9", proposal: { headline: "Escalate", reasons: [], reminder: null } });
    expect(await run(world({ task: promise }), () => resolveCollectionTaskCommand(actor(), { taskId: TASK, outcome: "resumed" }))).toMatchObject({
      ok: true,
      message: "The promise is closed. The agent's reminders to Acme go again.",
      startsCycle: true,
    });
    expect(mocks.close).toHaveBeenCalledWith({ actorId: USER, requestId: "req-9", outcome: "resolved" });
    mocks.close.mockRejectedValueOnce(new CustomerRequestError("closed"));
    expect(await run(world({ task: promise }), () => resolveCollectionTaskCommand(actor(), { taskId: TASK, outcome: "held", holdUntil: "2026-10-25" }))).toMatchObject({ ok: true });
  });

  it("marks an unchecked claim of payment not received before letting reminders go again or holding them", async () => {
    const claim = taskRow({ kind: "finance_review", reason: "claim_unverified", subject_key: "claim:req-7", proposal: { headline: "Escalate", reasons: [], reminder: null } });
    mocks.close.mockResolvedValue({ customerName: "Acme", kind: "paid" });
    expect(await run(world({ task: claim }), () => resolveCollectionTaskCommand(actor(), { taskId: TASK, outcome: "resumed" }))).toMatchObject({
      ok: true,
      message: "The claim of payment is marked not received. The agent's reminders to Acme go again.",
      startsCycle: true,
    });
    expect(mocks.close).toHaveBeenCalledWith({ actorId: USER, requestId: "req-7", outcome: "not_received" });
    expect(await run(world({ task: claim }), () => resolveCollectionTaskCommand(actor(), { taskId: TASK, outcome: "held", holdUntil: "2026-10-25" }))).toMatchObject({
      ok: true,
      message: "The claim of payment is marked not received. Reminders to Acme about this invoice wait until Oct 25, 2026.",
    });
    expect(mocks.close).toHaveBeenLastCalledWith({ actorId: USER, requestId: "req-7", outcome: "not_received" });
    expect(mocks.ledger).toHaveBeenCalledWith(ORG, expect.objectContaining({ action: "collection_task_resolved", detail: expect.objectContaining({ reason: "claim_unverified", outcome: "held" }) }));
  });

  it("says when someone resolved it first, and when it is not this workspace's", async () => {
    expect(await run(world({ resolved: [] }), () => resolveCollectionTaskCommand(actor(), { taskId: TASK, outcome: "approved" }))).toMatchObject({ ok: false, code: "changed", changed: true });
    expect(await run(world({ task: taskRow({ status: "done", outcome: "done", resolved_at: "2026-10-19T10:00:00Z" }) }), () => resolveCollectionTaskCommand(actor(), { taskId: TASK, outcome: "approved" }))).toMatchObject({
      ok: false,
      code: "changed",
    });
    expect(await run(world({ task: null }), () => resolveCollectionTaskCommand(actor(), { taskId: TASK, outcome: "approved" }))).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("the idempotency key (I11)", () => {
  const base = { kind: "collection_reminder" as const, event: `reminder:${INVOICE}:1`, recipient: "billing@acme.example" };

  it("is one per recipient and event, the same under any rules' version, and never carries the address", () => {
    const key = deliveryKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(deliveryKey({ ...base, recipient: " Billing@Acme.example " })).toBe(key);
    expect(deliveryKey({ ...base, recipient: "ap@acme.example" })).not.toBe(key);
    expect(deliveryKey({ ...base, event: `reminder:${INVOICE}:2` })).not.toBe(key);
    // A rules change is not a new email: a retry under newer rules keeps the key Resend knows.
    expect(deliveryKey({ ...base, policyVersion: 3 } as typeof base)).toBe(key);
    expect(deliveryKey({ ...base, kind: "collection_task" })).not.toBe(key);
    expect(recipientHash("billing@acme.example")).not.toContain("acme");
  });
});
