import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecideParams } from "@/lib/agent/decide";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import type { EmailMessage, SendResult } from "@/lib/email/send";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The collections stage (docs/superpowers/specs/2026-10-03-collections-design.md): a receivable whose reminders are
 * on, where code allows one now, is decided by the model beside the written policy (R3–R5), claimed before it is
 * sent (R7), emailed from the template with the pay link (R6), and signed; a wait is signed and remembered. First,
 * each receivable's next step from its customer's context (docs/superpowers/specs/2026-10-13-collections-context-design.md)
 * holds it, opens a task for a person, or lets it through; and each email goes once, its opt-out read again (I11).
 */

const { ledgerMock, decideMock } = vi.hoisted(() => ({ ledgerMock: vi.fn(), decideMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: ledgerMock }));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent/decide")>()), decide: decideMock }));

import { sendReceivableReminders } from "@/lib/agent/collections";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c0c";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001c1";
const CLIENT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000002c2";
const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003c3";
const KEYS = parseMasterKeys(`t1:${crypto.randomBytes(32).toString("base64")}`);
const TOKEN = `vxr_${"B".repeat(43)}`;
const NOW = Date.parse("2026-10-10T09:00:00Z");

const link = (over: Record<string, unknown> = {}) => ({
  id: "link-1",
  invoice_id: INVOICE,
  token_enc: encryptSecret(TOKEN, { orgId: ORG, column: "receivable_links.token_enc" }, KEYS),
  reminders_on_at: "2026-10-01T09:00:00Z",
  revoked_at: null,
  reminder_deferred_until: null,
  ...over,
});
const invoice = (over: Record<string, unknown> = {}) => ({
  id: INVOICE,
  counterparty_id: CLIENT,
  amount: "12.5",
  currency: "USDC",
  due_date: "2026-10-10T12:00:00+00:00",
  memo: "October retainer",
  po_reference: null,
  status: "pending",
  direction: "receivable",
  ...over,
});

interface World {
  mode?: string;
  paused?: boolean;
  links?: Array<Record<string, unknown>>;
  /** The link as read again right before the send (I11); the same as `links` when not given. */
  recheck?: Array<Record<string, unknown>>;
  invoices?: Array<Record<string, unknown>>;
  email?: string | null;
  sent?: Array<Record<string, unknown>>;
  history?: Array<Record<string, unknown>>;
  claim?: { status?: number; body: unknown };
  allocations?: { status?: number; body: unknown };
  /** What the customer said on its statement (0109). */
  requests?: { status?: number; body: unknown };
  /** The customer's rules (0110), newest version first. */
  policies?: Array<Record<string, unknown>>;
  /** The receivable's tasks (0110), the open ones, and the row a new one is inserted as. */
  tasks?: Array<Record<string, unknown>>;
  openTasks?: Array<Record<string, unknown>>;
  taskInsert?: { status?: number; body: unknown };
  /** A delivery claim's answer, and the row found when the claim inserts nothing (I11). */
  delivery?: { status?: number; body: unknown };
  deliveryFound?: Array<Record<string, unknown>>;
  /** The HubSpot deal the receivable's deal was planned from. */
  crm?: Array<Record<string, unknown>>;
  /** The members and their email switches, for a task's email. */
  members?: Array<Record<string, unknown>>;
  switches?: Array<Record<string, unknown>>;
}

/** What the database answers in `w`; `world(w)` records it. */
function responder(w: World = {}) {
  return (request: RecordedRequest): FakeReply => {
    if (request.path === "/rest/v1/orgs") return { body: { name: "Mai Studio", mode: w.mode ?? "live", slug: "mai" } };
    if (request.path === "/rest/v1/receivable_allocations") return w.allocations ?? { body: [] };
    if (request.path === "/rest/v1/customer_requests") return w.requests ?? { body: [] };
    if (request.path === "/rest/v1/rpc/agent_paused") return { body: w.paused === true };
    if (request.path === "/rest/v1/receivable_links" && request.method === "GET") {
      const again = request.params.get("invoice_id")?.startsWith("eq.");
      return { body: again ? (w.recheck ?? w.links ?? [link()]) : (w.links ?? [link()]) };
    }
    if (request.path === "/rest/v1/invoices" && request.method === "GET") {
      return { body: request.params.get("status") === "in.(pending,matched)" ? (w.invoices ?? [invoice()]) : (w.history ?? []) };
    }
    if (request.path === "/rest/v1/counterparties") return { body: [{ id: CLIENT, name: "Acme", notice_email: w.email === undefined ? "billing@acme.example" : w.email }] };
    if (request.path === "/rest/v1/ar_reminders" && request.method === "GET") return { body: w.sent ?? [] };
    if (request.path === "/rest/v1/ar_reminders" && request.method === "POST") return w.claim ?? { body: { id: "reminder-1" } };
    if (request.path === "/rest/v1/collection_policies" && request.method === "GET") return { body: w.policies ?? [] };
    if (request.path === "/rest/v1/collection_tasks" && request.method === "GET") {
      return { body: request.params.get("status") === "eq.open" ? (w.openTasks ?? []) : (w.tasks ?? []) };
    }
    if (request.path === "/rest/v1/collection_tasks" && request.method === "POST") return w.taskInsert ?? { body: [] };
    if (request.path === "/rest/v1/notification_deliveries" && request.method === "POST") return w.delivery ?? { body: [{ id: "delivery-1" }] };
    if (request.path === "/rest/v1/notification_deliveries" && request.method === "GET") return { body: w.deliveryFound ?? [] };
    if (request.path === "/rest/v1/crm_deals") return { body: w.crm ?? [] };
    if (request.path === "/rest/v1/accounting_connections") return { body: [{ id: "conn-1", provider: "hubspot", external_org_id: "4410" }] };
    if (request.path === "/rest/v1/rpc/org_members") {
      return { body: w.members ?? [{ user_id: OWNER, email: "owner@mai.example", role: "owner", joined_at: "2026-09-01T00:00:00Z" }] };
    }
    if (request.path === "/rest/v1/memberships") return { body: w.switches ?? [{ user_id: OWNER, notify_email: true, role: "owner" }] };
    return { body: [] };
  };
}

const world = (w: World = {}) => fakeSupabase(responder(w));

/** The model answers `answer`, or the written policy when it is not given. */
function model(answer?: Record<string, unknown>) {
  decideMock.mockImplementation(async (params: DecideParams<unknown>) => {
    const reference = params.fallback() as { action: string };
    const value = answer ? params.schema.parse({ ...reference, ...answer }) : reference;
    return { value, mode: "deepseek", reference, agreedWithReference: (value as { action: string }).action === reference.action };
  });
}

const sendMock = vi.fn<(message: EmailMessage) => Promise<SendResult>>(async () => ({ sent: true, id: "email-1" }));
const run = (client: ReturnType<typeof fakeSupabase>, over: { now?: number; network?: "arc-testnet" | "arc-mainnet" } = {}) =>
  runWith(orgTestContext({ config: { ...config, network: over.network ?? config.network }, client: client.client, orgId: ORG }), () =>
    sendReceivableReminders(db(), { now: over.now ?? NOW, send: sendMock, origin: "https://www.vestiarion.xyz", keys: KEYS })
  );

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
  decideMock.mockReset();
  sendMock.mockClear();
  model();
});

describe("a reminder the agent sends", () => {
  it("is decided beside the written policy, claimed, emailed with the pay link, and signed (R4–R7)", async () => {
    const client = world();
    const lines = await run(client);

    const asked = JSON.parse((decideMock.mock.calls[0][0] as DecideParams<unknown>).userPrompt) as Record<string, unknown>;
    expect(asked).toMatchObject({ receivable: { amount: 12.5, daysFromDueDate: 0, when: "on the due date" }, thisWouldBeReminder: 1, allowedTones: ["friendly"] });
    const claim = client.requests.find((r) => r.path === "/rest/v1/ar_reminders" && r.method === "POST")!;
    expect(claim.body).toMatchObject({ org_id: ORG, invoice_id: INVOICE, number: 1, tone: "friendly" });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const email = sendMock.mock.calls[0][0];
    expect(email.to).toBe("billing@acme.example");
    expect(email.subject).toBe("Mai Studio: 12.50 USDC due today");
    expect(email.text).toContain(`/pay/${TOKEN}`);
    expect(email.text).toContain("Mai Studio asked you to pay 12.50 USDC for October retainer, due today, Oct 10, 2026.");

    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "agent",
        domain: "ar",
        action: "ar_reminder_sent",
        summary: "Reminded Acme by email of 12.50 USDC due Oct 10, 2026 (friendly)",
        detail: expect.objectContaining({ invoiceId: INVOICE, to: "bi***@acme.example", number: 1, tone: "friendly", daysFromDue: 0, decisionMode: "deepseek", agreedWithReference: true }),
      })
    );
    expect(lines).toEqual([{ domain: "ar", message: "Reminded Acme by email: 12.50 USDC due Oct 10, 2026 (friendly)" }]);
  });

  it("tells the client to pay on the workspace's network: Arc mainnet for a workspace there (mainnet copy C1)", async () => {
    await run(world(), { network: "arc-mainnet" });
    const email = sendMock.mock.calls[0][0];
    expect(email.text).toContain("Pay on Arc mainnet:");
    expect(email.text).not.toContain("Arc testnet");
  });

  it("goes out no firmer than code allows, and the entry says what the model chose (R5)", async () => {
    model({ action: "send", tone: "final" });
    await run(world({ invoices: [invoice({ due_date: "2026-10-08T12:00:00+00:00" })] }));
    expect(sendMock.mock.calls[0][0].subject).toBe("Reminder: 12.50 USDC to Mai Studio was due Oct 8, 2026");
    const detail = ledgerMock.mock.calls[0][0].detail;
    expect(detail).toMatchObject({ tone: "firm", toneLimited: { chosen: "final", sent: "firm" } });
    expect(detail.decision.reasoning).toContain("code allows friendly or firm 2 days after the due date with 0 sent, so it went out firm");
  });
});

describe("a wait the model chooses", () => {
  it("is remembered on the link and signed, and nothing is sent (R5)", async () => {
    model({ action: "wait", waitDays: 2, reasoning: "Acme always pays on its due date; a reminder this morning adds nothing." });
    const client = world();
    await run(client);
    expect(sendMock).not.toHaveBeenCalled();
    const patch = client.requests.find((r) => r.path === "/rest/v1/receivable_links" && r.method === "PATCH")!;
    expect(patch.body).toEqual({ reminder_deferred_until: "2026-10-12T09:00:00.000Z" });
    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ar_reminder_deferred",
        summary: "Decided to wait 2 days before reminding Acme of 12.50 USDC",
        detail: expect.objectContaining({ until: "2026-10-12T09:00:00.000Z", decision: { action: "wait", waitDays: 2, reasoning: "Acme always pays on its due date; a reminder this morning adds nothing." }, agreedWithReference: false }),
      })
    );
  });
});

describe("what sends nothing", () => {
  it.each<[string, World]>([
    ["a sandbox", { mode: "sandbox" }],
    ["a paused agent", { paused: true }],
    ["no receivable with reminders on", { links: [] }],
    ["a receivable already received", { invoices: [invoice({ status: "received" })] }],
    ["a client with no billing email", { email: null }],
    ["a link made before links were kept", { links: [link({ token_enc: null })] }],
    ["a reminder less than 3 days ago", { sent: [{ invoice_id: INVOICE, number: 1, tone: "friendly", sent_at: "2026-10-08T09:00:00Z" }] }],
    ["a wait still running", { links: [link({ reminder_deferred_until: "2026-10-11T09:00:00Z" })] }],
  ])("%s", async (_label, w) => {
    await run(world(w));
    expect(decideMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("a reminder another cycle claimed first", async () => {
    await run(world({ claim: { status: 409, body: { code: "23505", message: "duplicate key value violates unique constraint" } } }));
    expect(sendMock).not.toHaveBeenCalled();
    expect(ledgerMock).not.toHaveBeenCalled();
  });
});

describe("a send that fails", () => {
  it("releases its claim, so the next cycle may try again, and signs nothing (R7)", async () => {
    sendMock.mockResolvedValueOnce({ sent: false, reason: "resend 500" });
    const client = world();
    const lines = await run(client);
    const released = client.requests.find((r) => r.path === "/rest/v1/ar_reminders" && r.method === "DELETE")!;
    expect(released.params.get("id")).toBe("eq.reminder-1");
    expect(ledgerMock).not.toHaveBeenCalled();
    expect(lines).toEqual([{ domain: "ar", message: "Reminder to Acme not sent (resend 500); tried again at the next cycle" }]);
  });
});

describe("a part-paid receivable (allocations L11)", () => {
  const applied = (amount: string) => ({
    id: "alloc-1",
    kind: "payment",
    invoice_id: INVOICE,
    transfer_id: "transfer-1",
    amount,
    currency: "USDC",
    reverses: null,
    reason: null,
    basis: "person",
    payment_seq: 1,
    created_by: "person-1",
    created_at: "2026-10-09T09:00:00Z",
  });

  it("is reminded of what is still owed, and told what arrived", async () => {
    await run(world({ allocations: { body: [applied("5.000000")] } }));
    const asked = JSON.parse((decideMock.mock.calls[0][0] as DecideParams<unknown>).userPrompt) as Record<string, unknown>;
    expect(asked).toMatchObject({ receivable: { amount: 7.5, partPaid: { invoiced: 12.5, alreadyReceived: 5 } } });
    const email = sendMock.mock.calls[0][0];
    expect(email.subject).toBe("Mai Studio: 7.50 USDC due today");
    expect(email.text).toContain("5.00 USDC of the 12.50 USDC invoiced has arrived. What is still owed is 7.50 USDC.");
    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ar_reminder_sent",
        summary: "Reminded Acme by email of 7.50 USDC due Oct 10, 2026 (friendly)",
        detail: expect.objectContaining({ amount: 7.5, partPaid: { invoiced: 12.5, received: 5 } }),
      })
    );
  });

  it("never tells the client a fee arrived from them: what arrived is what they paid", async () => {
    const fee = { ...applied("0.500000"), id: "alloc-fee", kind: "fee", transfer_id: null, reason: "Transfer fee", basis: null, payment_seq: null, created_at: "2026-10-09T09:01:00Z" };
    await run(world({ allocations: { body: [applied("5.000000"), fee] } }));
    const asked = JSON.parse((decideMock.mock.calls[0][0] as DecideParams<unknown>).userPrompt) as Record<string, unknown>;
    expect(asked).toMatchObject({ receivable: { amount: 7, partPaid: { invoiced: 12.5, alreadyReceived: 5 } } });
    expect(sendMock.mock.calls[0][0].text).toContain("5.00 USDC of the 12.50 USDC invoiced has arrived. What is still owed is 7.00 USDC.");
    expect(ledgerMock).toHaveBeenCalledWith(expect.objectContaining({ action: "ar_reminder_sent", detail: expect.objectContaining({ amount: 7, partPaid: { invoiced: 12.5, received: 5 } }) }));
  });

  it("is not reminded once nothing is owed", async () => {
    const lines = await run(world({ allocations: { body: [applied("12.500000")] } }));
    expect(decideMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it("is reminded of the whole invoice before migration 0103 runs", async () => {
    await run(world({ allocations: { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.receivable_allocations' in the schema cache" } } }));
    expect(sendMock.mock.calls[0][0].subject).toBe("Mai Studio: 12.50 USDC due today");
  });
});

describe("a receivable its customer answered on its statement (customer portal P7)", () => {
  const said = (over: Record<string, unknown>) => ({
    id: "req-1",
    invoice_id: INVOICE,
    status: "open",
    outcome: null,
    promised_on: null,
    paid_on: null,
    created_at: "2026-10-08T09:00:00Z",
    closed_at: null,
    ...over,
  });

  it("waits through the day the customer promised to pay", async () => {
    const lines = await run(world({ requests: { body: [said({ kind: "promise", promised_on: "2026-10-10" })] } }));
    expect(decideMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it("is not reminded once the promised day passed: finance reviews it first (collections context C3)", async () => {
    await run(world({ requests: { body: [said({ id: "req-promise", kind: "promise", promised_on: "2026-10-09" })] } }));
    expect(decideMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("waits while the customer says it paid and the payment is not found yet (collections context C2)", async () => {
    await run(world({ requests: { body: [said({ kind: "paid", paid_on: "2026-10-09" })] } }));
    expect(decideMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("waits while the customer disputes it", async () => {
    await run(world({ requests: { body: [said({ kind: "dispute" })] } }));
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("asks only for what the customers of its open receivables said: open, or closed in the last 90 days", async () => {
    const client = world();
    await run(client);
    const asked = client.requests.find((r) => r.path === "/rest/v1/customer_requests")!;
    expect(asked.params.get("invoice_id")).toBe(`in.(${INVOICE})`);
    expect(asked.params.get("or")).toBe("(status.eq.open,closed_at.gte.2026-07-12T09:00:00.000Z)");
    expect(asked.params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("is reminded as before when migration 0109 has not run", async () => {
    await run(world({ requests: { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.customer_requests' in the schema cache" } } }));
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

/** A collection task as the database returns it (0110). */
const taskRow = (over: Record<string, unknown> = {}) => ({
  id: "task-1",
  invoice_id: INVOICE,
  counterparty_id: CLIENT,
  kind: "ask_owner",
  reason: "policy_ask_first",
  subject_key: "policy:1:reminder:1",
  assignee: null,
  policy_version: 1,
  proposal: {
    headline: "Ask the account owner before reminding",
    reasons: [{ code: "due_today", text: "Due today." }],
    reminder: { number: 1, tone: "friendly", tones: ["friendly"], channel: "email", daysFromDue: 0, owed: 12.5, received: 0 },
  },
  status: "open",
  outcome: null,
  hold_until: null,
  approved_number: null,
  approved_tone: null,
  resolved_at: null,
  resolved_by: null,
  notified_at: null,
  created_at: "2026-10-10T08:00:00Z",
  ...over,
});
const rules = (over: Record<string, unknown> = {}) => ({
  id: "policy-1",
  counterparty_id: CLIENT,
  version: 1,
  approval: "ask_first",
  max_tone: "final",
  min_days_between: 3,
  channel: "email",
  account_owner: OWNER,
  created_by: OWNER,
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});
const posted = (client: ReturnType<typeof world>, path: string) => client.requests.filter((r) => r.path === path && r.method === "POST");
const patched = (client: ReturnType<typeof world>, path: string) => client.requests.filter((r) => r.path === path && r.method === "PATCH");

describe("the customer's context (collections context C1-C6)", () => {
  it("a broken promise opens a finance review task, signed, and emails the owners once, with an idempotency key", async () => {
    const promise = { id: "req-promise", invoice_id: INVOICE, kind: "promise", status: "open", outcome: null, promised_on: "2026-10-09", paid_on: null, created_at: "2026-10-05T09:00:00Z", closed_at: null };
    const opened = taskRow({
      kind: "finance_review",
      reason: "promise_passed",
      subject_key: "promise:req-promise",
      policy_version: 0,
      proposal: { headline: "Escalate to finance: a promise was broken", reasons: [{ code: "promise_passed", text: "The customer promised to pay by Oct 9, 2026." }], reminder: null },
    });
    const client = world({ requests: { body: [promise] }, taskInsert: { body: [opened] } });
    await run(client);
    expect(decideMock).not.toHaveBeenCalled();
    expect(posted(client, "/rest/v1/collection_tasks")[0].body).toMatchObject({
      org_id: ORG,
      invoice_id: INVOICE,
      counterparty_id: CLIENT,
      kind: "finance_review",
      reason: "promise_passed",
      subject_key: "promise:req-promise",
      policy_version: 0,
    });
    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "agent", action: "collection_task_opened", detail: expect.objectContaining({ taskId: "task-1", reason: "promise_passed", invoiceId: INVOICE }) })
    );
    // The one email is to the owner, about the task: never to the customer.
    expect(sendMock).toHaveBeenCalledTimes(1);
    const email = sendMock.mock.calls[0][0];
    expect(email.to).toBe("owner@mai.example");
    expect(email.subject).toBe("Acme missed the day it promised to pay");
    expect(email.text).toContain(`https://www.vestiarion.xyz/o/mai/invoices?tab=receivables&open=${INVOICE}`);
    expect(email.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(posted(client, "/rest/v1/notification_deliveries")[0].body).toMatchObject({ kind: "collection_task", subject_id: "task-1", policy_version: 0 });
    expect(patched(client, "/rest/v1/collection_tasks")[0].body).toEqual({ notified_at: "2026-10-10T09:00:00.000Z" });
  });

  it("rules that say ask first open a task with the drafted reminder, and send nothing to the customer", async () => {
    const client = world({ policies: [rules()], taskInsert: { body: [taskRow({ notified_at: "2026-10-10T09:00:00Z" })] } });
    await run(client);
    expect(decideMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(posted(client, "/rest/v1/collection_tasks")[0].body).toMatchObject({
      kind: "ask_owner",
      reason: "policy_ask_first",
      subject_key: "policy:1:reminder:1",
      assignee: OWNER,
      policy_version: 1,
      proposal: expect.objectContaining({ reminder: expect.objectContaining({ number: 1, tone: "friendly" }) }),
    });
    expect(posted(client, "/rest/v1/ar_reminders")).toHaveLength(0);
  });

  it("a reminder a person approved goes at their tone without the model, and says who approved it", async () => {
    const approved = taskRow({ status: "done", outcome: "approved", approved_number: 1, approved_tone: "friendly", resolved_at: "2026-10-10T08:30:00Z", resolved_by: OWNER });
    await run(world({ policies: [rules()], tasks: [approved] }));
    expect(decideMock).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].to).toBe("billing@acme.example");
    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ar_reminder_sent",
        detail: expect.objectContaining({ tone: "friendly", decisionMode: "person", approvedTaskId: "task-1", approvedBy: OWNER, context: expect.objectContaining({ policyVersion: 1 }) }),
      })
    );
  });

  it("a HubSpot deal with an owner asks before the first overdue reminder", async () => {
    const client = world({
      invoices: [invoice({ due_date: "2026-10-08T12:00:00+00:00", deal_id: "deal-1" })],
      crm: [{ deal_id: "deal-1", connection_id: "conn-1", external_id: "9001", name: "Website rebuild", owner_external_id: "77" }],
    });
    await run(client);
    expect(decideMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(posted(client, "/rest/v1/collection_tasks")[0].body).toMatchObject({ kind: "ask_owner", reason: "hubspot_owner", subject_key: "hubspot:9001" });
  });

  it("closes an open task the receivable no longer needs, and one whose receivable is no longer open", async () => {
    const gone = "0b6c1c9e-4a4f-4a7e-9b1e-0000000009c9";
    const client = world({ tasks: [taskRow()], openTasks: [taskRow(), taskRow({ id: "task-gone", invoice_id: gone })] });
    await run(client);
    const closed = patched(client, "/rest/v1/collection_tasks").find((r) => (r.body as { outcome?: string }).outcome === "obsolete");
    expect(closed?.params.get("id")).toBe("in.(task-1,task-gone)");
    expect(closed?.params.get("status")).toBe("eq.open");
  });
});

describe("each email once, the opt-out read again (I11)", () => {
  it("sends a reminder under the key of its recipient, reminder and rules' version, and marks it sent", async () => {
    const client = world();
    await run(client);
    const claim = posted(client, "/rest/v1/notification_deliveries")[0];
    expect(claim.body).toMatchObject({ org_id: ORG, kind: "collection_reminder", subject_id: INVOICE, policy_version: 0 });
    const key = (claim.body as { idempotency_key: string }).idempotency_key;
    expect(sendMock.mock.calls[0][0].idempotencyKey).toBe(key);
    expect((claim.body as { recipient_hash: string }).recipient_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(claim.body)).not.toContain("billing@acme.example");
    expect(patched(client, "/rest/v1/notification_deliveries")[0].body).toMatchObject({ provider_id: "email-1" });
  });

  it("never sends again what went out under the same key, and keeps the reminder's claim", async () => {
    const client = world({ delivery: { body: [] }, deliveryFound: [{ sent_at: "2026-10-10T08:00:00Z" }] });
    const lines = await run(client);
    expect(sendMock).not.toHaveBeenCalled();
    expect(client.requests.some((r) => r.path === "/rest/v1/ar_reminders" && r.method === "DELETE")).toBe(false);
    expect(lines).toContainEqual({ domain: "ar", message: "Reminder 1 to Acme went out already; not sent again" });
  });

  it("stops when reminders were turned off between the decision and the send, and releases both claims", async () => {
    const client = world({ recheck: [{ reminders_on_at: null, revoked_at: null }] });
    const lines = await run(client);
    expect(sendMock).not.toHaveBeenCalled();
    expect(client.requests.find((r) => r.path === "/rest/v1/ar_reminders" && r.method === "DELETE")?.params.get("id")).toBe("eq.reminder-1");
    expect(client.requests.find((r) => r.path === "/rest/v1/notification_deliveries" && r.method === "DELETE")?.params.get("id")).toBe("eq.delivery-1");
    expect(ledgerMock).not.toHaveBeenCalled();
    expect(lines).toEqual([{ domain: "ar", message: "Reminder to Acme not sent: its reminders or its rules changed just before the send" }]);
  });

  it("stops when the customer's rules changed between the decision and the send", async () => {
    const base = responder();
    let reads = 0;
    const client = fakeSupabase((request) => {
      if (request.path === "/rest/v1/collection_policies") {
        reads += 1;
        // Read with the context, then again right before the send: a version saved in between.
        return { body: reads === 1 ? [] : [rules({ approval: "auto" })] };
      }
      return base(request);
    });
    await run(client);
    expect(reads).toBe(2);
    expect(sendMock).not.toHaveBeenCalled();
    expect(client.requests.find((r) => r.path === "/rest/v1/ar_reminders" && r.method === "DELETE")).toBeDefined();
  });

  it("emails a task's member only while their email switch is on at the send", async () => {
    const done = [
      { invoice_id: INVOICE, number: 1, tone: "friendly", sent_at: "2026-09-01T09:00:00Z" },
      { invoice_id: INVOICE, number: 2, tone: "firm", sent_at: "2026-09-05T09:00:00Z" },
      { invoice_id: INVOICE, number: 3, tone: "final", sent_at: "2026-09-10T09:00:00Z" },
    ];
    const open = taskRow({ kind: "finance_review", reason: "reminders_done", subject_key: "reminders_done", proposal: { headline: "Escalate to finance: reminders are done", reasons: [], reminder: null } });
    const base = responder({ sent: done, tasks: [open], openTasks: [open] });
    let switchReads = 0;
    const client = fakeSupabase((request) => {
      if (request.path === "/rest/v1/memberships") {
        switchReads += 1;
        // On when the recipients are chosen, off when read again right before the send.
        return { body: [{ user_id: OWNER, notify_email: switchReads === 1, role: "owner" }] };
      }
      return base(request);
    });
    await run(client);
    expect(switchReads).toBe(2);
    expect(sendMock).not.toHaveBeenCalled();
    expect(client.requests.find((r) => r.path === "/rest/v1/notification_deliveries" && r.method === "DELETE")).toBeDefined();
    expect(patched(client, "/rest/v1/collection_tasks").some((r) => "notified_at" in (r.body as object))).toBe(false);
  });
});
