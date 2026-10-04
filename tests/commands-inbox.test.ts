import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/commands/actor";
import { addFromInbox, dismissFromInbox, finishFromInbox } from "@/lib/commands/inbox";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { invoiceInputSchema } from "@/lib/intake-validation";
import { withOrg } from "@/lib/dal/scope";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * A person's decision on an invoice that arrived by email (email invoices design E7, E8): an owner or admin adds it as
 * a payable once, as themselves, through the command every surface shares, the entry naming email and the inbox row;
 * or dismisses it. An approver or a viewer does neither.
 */

const { runCycleSoonMock } = vi.hoisted(() => ({ runCycleSoonMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: runCycleSoonMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e31";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e32";
const ROW = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e33";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e34";
const COUNTERPARTY = { id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de", name: "Northwind Hosting" };
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const STORED = {
  draft: { counterpartyId: COUNTERPARTY.id, amount: "200.00", currency: "USDC", memo: "", poReference: "PO-1042", dueDate: "2026-10-31", earlyPayDiscountPct: "", discountDeadline: "" },
  document: { kind: "pdf", sha256: "a".repeat(64), reader: "heuristic" },
};

let claimed: unknown[];
let counterpartyGone: boolean;
/** The inbox row as finishFromInbox reads it. */
let row: unknown;

beforeEach(() => {
  claimed = [{ draft: STORED }];
  counterpartyGone = false;
  row = null;
  runCycleSoonMock.mockReset();
});

const actor = (role: Actor["role"] = "admin"): Actor => ({ orgId: ORG, userId: USER, role, mode: "live", surface: { kind: "console" } });

function world() {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/inbox_emails" && sent.method === "GET") return { body: row };
    if (sent.path === "/rest/v1/inbox_emails" && sent.method === "PATCH") {
      const body = sent.body as { status?: string };
      if (body.status === "added") return { body: claimed };
      if (body.status === "dismissed") return { body: [{ id: ROW }] };
      return { body: [{ id: ROW }] };
    }
    if (sent.path === "/rest/v1/counterparties") return { body: counterpartyGone ? null : COUNTERPARTY };
    if (sent.path === "/rest/v1/invoices" && sent.method === "POST") return { body: { id: INVOICE } };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn, { userId: USER }));
  return { fake, run };
}

const inboxPatches = (requests: RecordedRequest[]) =>
  requests.filter((sent) => sent.path === "/rest/v1/inbox_emails" && sent.method === "PATCH");
const ledger = (requests: RecordedRequest[]) =>
  requests.filter((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry").map((sent) => sent.body as { p_action: string; p_detail: Record<string, unknown> });

describe("addFromInbox", () => {
  it("claims the draft once, adds it as the member naming email and the row, links the invoice, and starts the agent", async () => {
    const { fake, run } = world();
    const outcome = await run(() => addFromInbox(actor(), { inboxEmailId: ROW, goodsReceived: true }));

    expect(outcome).toMatchObject({ ok: true, invoiceId: INVOICE });
    const [claim, link] = inboxPatches(fake.requests);
    expect(claim.params.get("id")).toBe(`eq.${ROW}`);
    expect(claim.params.get("status")).toBe("eq.ready");
    expect(claim.body).toMatchObject({ status: "added", decided_by: USER });
    expect(link.body).toEqual({ invoice_id: INVOICE });
    const insert = fake.requests.find((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST");
    expect(insert?.body).toMatchObject({ direction: "payable", amount: "200.00", goods_received: true, created_by: USER });
    const [entry] = ledger(fake.requests);
    expect(entry.p_action).toBe("create_invoice");
    expect(entry.p_detail).toMatchObject({ by: USER, via: "email", inboxEmailId: ROW, document: { kind: "pdf", changed: [] } });
    expect(runCycleSoonMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, kind: "invoice_added" }));
  });

  it("adds nothing for an email already decided, or one that cannot be added as read", async () => {
    claimed = [];
    const { fake, run } = world();
    const outcome = await run(() => addFromInbox(actor(), { inboxEmailId: ROW, goodsReceived: false }));
    expect(outcome).toMatchObject({ ok: false, code: "not_ready" });
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/invoices")).toBe(false);
  });

  it("refuses an approver, before claiming anything", async () => {
    const { fake, run } = world();
    expect(await run(() => addFromInbox(actor("approver"), { inboxEmailId: ROW, goodsReceived: true }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(inboxPatches(fake.requests)).toEqual([]);
  });

  it("puts the draft back when the invoice could not be added", async () => {
    counterpartyGone = true;
    const { fake, run } = world();
    expect(await run(() => addFromInbox(actor(), { inboxEmailId: ROW, goodsReceived: true }))).toMatchObject({ ok: false });
    const restored = inboxPatches(fake.requests).at(-1);
    expect(restored?.body).toMatchObject({ status: "ready", decided_by: null, decided_at: null });
    expect(restored?.params.get("status")).toBe("eq.added");
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST")).toBe(false);
  });
});

describe("finishFromInbox (reader follow-up F5)", () => {
  /** What the inbox read of an email it could not add: no amount, and a vendor name that matched no counterparty. */
  const READ = {
    counterpartyName: null, vendorName: "Northwind Hosting GmbH", amount: null, currency: "USDC", dueDate: "2026-10-31", poReference: "PO-1042",
    invoiceNumber: "INV-2207", memo: null, warnings: [], modelNote: null, reader: "deepseek", knownSender: false,
    counterpartyId: null, earlyPayDiscountPct: null, discountDeadline: null, document: { kind: "pdf", sha256: "b".repeat(64) },
  };
  /** The invoice as the person finished it: the counterparty chosen and the amount typed in. */
  const finished = (fields: Record<string, unknown> = {}) =>
    invoiceInputSchema.parse({
      direction: "payable", counterpartyId: COUNTERPARTY.id, amount: "200.00", currency: "USDC", memo: "", poReference: "PO-1042",
      goodsReceived: true, dueDate: "2026-10-31", earlyPayDiscountPct: "", discountDeadline: "", ...fields,
    });

  it("adds an email that needed details as the person finished it, naming the email, the document and what they changed", async () => {
    row = { status: "needs_details", read: READ, draft: null };
    const { fake, run } = world();
    const outcome = await run(() => finishFromInbox(actor(), { inboxEmailId: ROW, invoice: finished() }));

    expect(outcome).toMatchObject({ ok: true, invoiceId: INVOICE });
    const [claim, link] = inboxPatches(fake.requests);
    expect(claim.params.get("id")).toBe(`eq.${ROW}`);
    expect(claim.params.get("status")).toBe("eq.needs_details");
    expect(claim.body).toMatchObject({ status: "added", decided_by: USER });
    expect(link.body).toEqual({ invoice_id: INVOICE });
    const insert = fake.requests.find((sent) => sent.path === "/rest/v1/invoices" && sent.method === "POST");
    expect(insert?.body).toMatchObject({ direction: "payable", amount: "200.00", goods_received: true, created_by: USER });
    const [entry] = ledger(fake.requests);
    expect(entry.p_action).toBe("create_invoice");
    expect(entry.p_detail).toMatchObject({
      by: USER, via: "email", inboxEmailId: ROW,
      document: { kind: "pdf", sha256: "b".repeat(64), reader: "deepseek", changed: ["amount", "counterpartyId"] },
    });
    expect(runCycleSoonMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, kind: "invoice_added" }));
  });

  it("adds an email that could not be read as it was typed in, naming the email and no document", async () => {
    row = { status: "unreadable", read: null, draft: null };
    const { fake, run } = world();
    expect(await run(() => finishFromInbox(actor(), { inboxEmailId: ROW, invoice: finished() }))).toMatchObject({ ok: true });
    expect(inboxPatches(fake.requests)[0].params.get("status")).toBe("eq.unreadable");
    const [entry] = ledger(fake.requests);
    expect(entry.p_detail).toMatchObject({ via: "email", inboxEmailId: ROW });
    expect(entry.p_detail.document ?? null).toBeNull();
  });

  it("compares a ready email read before the inbox kept its document with the stored draft", async () => {
    const { counterpartyId: _kept, document: _doc, ...older } = READ;
    row = { status: "ready", read: older, draft: STORED };
    const { fake, run } = world();
    expect(await run(() => finishFromInbox(actor(), { inboxEmailId: ROW, invoice: finished({ dueDate: "2026-11-15" }) }))).toMatchObject({ ok: true });
    expect(inboxPatches(fake.requests)[0].params.get("status")).toBe("eq.ready");
    expect(ledger(fake.requests)[0].p_detail).toMatchObject({ document: { kind: "pdf", sha256: "a".repeat(64), reader: "heuristic", changed: ["dueDate"] } });
  });

  it("adds nothing for an email already decided, or decided by someone else in between", async () => {
    row = { status: "added", read: READ, draft: null };
    const first = world();
    expect(await first.run(() => finishFromInbox(actor(), { inboxEmailId: ROW, invoice: finished() }))).toMatchObject({ ok: false, code: "not_found" });
    expect(inboxPatches(first.fake.requests)).toEqual([]);

    row = { status: "needs_details", read: READ, draft: null };
    claimed = [];
    const second = world();
    expect(await second.run(() => finishFromInbox(actor(), { inboxEmailId: ROW, invoice: finished() }))).toMatchObject({ ok: false, code: "not_found" });
    expect(second.fake.requests.some((sent) => sent.path === "/rest/v1/invoices")).toBe(false);
  });

  it("puts the email back as it was when the invoice could not be added", async () => {
    row = { status: "needs_details", read: READ, draft: null };
    counterpartyGone = true;
    const { fake, run } = world();
    expect(await run(() => finishFromInbox(actor(), { inboxEmailId: ROW, invoice: finished() }))).toMatchObject({ ok: false });
    const restored = inboxPatches(fake.requests).at(-1);
    expect(restored?.body).toMatchObject({ status: "needs_details", decided_by: null, decided_at: null });
    expect(restored?.params.get("status")).toBe("eq.added");
  });

  it("refuses an approver before reading anything, and a receivable", async () => {
    row = { status: "needs_details", read: READ, draft: null };
    const { fake, run } = world();
    expect(await run(() => finishFromInbox(actor("approver"), { inboxEmailId: ROW, invoice: finished() }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/inbox_emails")).toBe(false);
    expect(await run(() => finishFromInbox(actor(), { inboxEmailId: ROW, invoice: finished({ direction: "receivable" }) }))).toMatchObject({ ok: false, code: "invalid" });
    expect(inboxPatches(fake.requests)).toEqual([]);
  });
});

describe("dismissFromInbox", () => {
  it("dismisses an email still to decide, and records who did", async () => {
    const { fake, run } = world();
    expect(await run(() => dismissFromInbox(actor(), { inboxEmailId: ROW }))).toMatchObject({ ok: true });
    const [dismiss] = inboxPatches(fake.requests);
    expect(dismiss.body).toMatchObject({ status: "dismissed", decided_by: USER });
    expect(dismiss.params.get("status")).toBe("in.(received,ready,needs_details,unreadable)");
    expect(ledger(fake.requests).map((entry) => [entry.p_action, entry.p_detail])).toEqual([["invoice_email_dismissed", { by: USER, inboxEmailId: ROW }]]);
  });

  it("refuses a viewer", async () => {
    const { run } = world();
    expect(await run(() => dismissFromInbox(actor("viewer"), { inboxEmailId: ROW }))).toMatchObject({ ok: false, code: "forbidden" });
  });
});
