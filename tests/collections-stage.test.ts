import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecideParams } from "@/lib/agent/decide";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import type { EmailMessage, SendResult } from "@/lib/email/send";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * The collections stage (docs/superpowers/specs/2026-10-03-collections-design.md): a receivable whose reminders are
 * on, where code allows one now, is decided by the model beside the written policy (R3–R5), claimed before it is
 * sent (R7), emailed from the template with the pay link (R6), and signed; a wait is signed and remembered.
 */

const { ledgerMock, decideMock } = vi.hoisted(() => ({ ledgerMock: vi.fn(), decideMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: ledgerMock }));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent/decide")>()), decide: decideMock }));

import { sendReceivableReminders } from "@/lib/agent/collections";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c0c";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001c1";
const CLIENT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000002c2";
const KEYS = parseMasterKeys(`t1:${crypto.randomBytes(32).toString("base64")}`);
const TOKEN = `vxr_${"B".repeat(43)}`;
const NOW = Date.parse("2026-10-10T09:00:00Z");

const link = (over: Record<string, unknown> = {}) => ({
  id: "link-1",
  invoice_id: INVOICE,
  token_enc: encryptSecret(TOKEN, { orgId: ORG, column: "receivable_links.token_enc" }, KEYS),
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
  invoices?: Array<Record<string, unknown>>;
  email?: string | null;
  sent?: Array<Record<string, unknown>>;
  history?: Array<Record<string, unknown>>;
  claim?: { status?: number; body: unknown };
}

function world(w: World = {}) {
  return fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs") return { body: { name: "Mai Studio", mode: w.mode ?? "live" } };
    if (request.path === "/rest/v1/rpc/agent_paused") return { body: w.paused === true };
    if (request.path === "/rest/v1/receivable_links" && request.method === "GET") return { body: w.links ?? [link()] };
    if (request.path === "/rest/v1/invoices" && request.method === "GET") {
      return { body: request.params.has("id") ? (w.invoices ?? [invoice()]) : (w.history ?? []) };
    }
    if (request.path === "/rest/v1/counterparties") return { body: [{ id: CLIENT, name: "Acme", notice_email: w.email === undefined ? "billing@acme.example" : w.email }] };
    if (request.path === "/rest/v1/ar_reminders" && request.method === "GET") return { body: w.sent ?? [] };
    if (request.path === "/rest/v1/ar_reminders" && request.method === "POST") return w.claim ?? { body: { id: "reminder-1" } };
    return { body: [] };
  });
}

/** The model answers `answer`, or the written policy when it is not given. */
function model(answer?: Record<string, unknown>) {
  decideMock.mockImplementation(async (params: DecideParams<unknown>) => {
    const reference = params.fallback() as { action: string };
    const value = answer ? params.schema.parse({ ...reference, ...answer }) : reference;
    return { value, mode: "deepseek", reference, agreedWithReference: (value as { action: string }).action === reference.action };
  });
}

const sendMock = vi.fn<(message: EmailMessage) => Promise<SendResult>>(async () => ({ sent: true, id: "email-1" }));
const run = (client: ReturnType<typeof fakeSupabase>, over: { now?: number } = {}) =>
  runWith(orgTestContext({ config, client: client.client, orgId: ORG }), () =>
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
