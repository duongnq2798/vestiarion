import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/v1/invoices/route";
import { operationById } from "@/lib/api/openapi";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { authenticateApiKey, type AuthenticatedKey } from "@/lib/platform/api-keys";
import { carriesOrg, fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * `POST /api/v1/invoices` (docs/superpowers/specs/2026-10-03-write-api-design.md R2, R3, R4, R5, R7): a read-and-write
 * key adds an invoice through the same `createInvoice` the form and the Telegram bot use, as its issuer's, and a payable
 * starts the agent's cycle as one typed in does. A body that does not validate is answered with 400, naming the field,
 * before anything is written or remembered; a counterparty the workspace does not hold is answered with 400 too.
 */

const { cycleMock } = vi.hoisted(() => ({ cycleMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: cycleMock, raiseCycleEvent: vi.fn() }));
vi.mock("@/lib/platform/api-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/api-keys")>();
  return { ...actual, authenticateApiKey: vi.fn(), touchApiKeyUsed: vi.fn(async () => {}) };
});

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const ISSUER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a1";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
let keyCounter = 0;
let key: AuthenticatedKey;

/** A fresh key per test, so the per-key write limit never carries over. */
function writeKey(overrides: Partial<AuthenticatedKey> = {}): AuthenticatedKey {
  keyCounter += 1;
  return { keyId: `2b2b2b2b-0000-4000-8000-${String(keyCounter).padStart(12, "0")}`, orgId: ORG, scopes: ["read", "write"], createdBy: ISSUER, ...overrides };
}

function useKey(overrides: Partial<AuthenticatedKey> = {}) {
  key = writeKey(overrides);
  vi.mocked(authenticateApiKey).mockResolvedValue(key);
}

beforeEach(() => {
  cycleMock.mockReset();
  vi.mocked(authenticateApiKey).mockReset();
  useKey();
});

const STORED = {
  id: INVOICE, direction: "payable", status: "pending", amount: "10.5", currency: "USDC", memo: "Landing page design", po_reference: "PO-7",
  goods_received: true, due_date: "2026-10-31T12:00:00+00:00", scheduled_for: null, early_pay_discount_pct: "2",
  discount_due_date: "2026-10-20T12:00:00+00:00", decided_at: null, settled_at: null, escalated_at: null, agent_reasoning: null, tx_ref: null,
  paid_amount: null, created_at: "2026-10-03T10:00:00Z", counterparties: { id: COUNTERPARTY, name: "Acme Supplies", risk_level: "clear" },
};

function workspace(options: { mode?: "sandbox" | "live"; counterparties?: Array<{ id: string; name: string }> } = {}) {
  const counterparties = options.counterparties ?? [{ id: COUNTERPARTY, name: "Acme Supplies" }];
  const fake = fakeSupabase((sent: RecordedRequest) => {
    // The key's issuer, read again at every write (part 2, W5): an admin, who may add records.
    if (sent.path === "/rest/v1/memberships") return { body: [{ role: "admin" }] };
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG, { mode: options.mode ?? "sandbox" }) };
    if (sent.path === "/rest/v1/counterparties") return { body: counterparties.filter((row) => sent.params.get("id") === `eq.${row.id}`) };
    if (sent.path === "/rest/v1/invoices" && sent.method === "POST") return { body: { id: INVOICE } };
    if (sent.path === "/rest/v1/invoices" && sent.method === "GET") return { body: STORED };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    if (sent.path === "/rest/v1/api_idempotency" && sent.method === "POST") return { status: 201, body: [{ org_id: ORG }] };
    return { body: [] };
  });
  const send = (body: unknown, headers: Record<string, string> = {}) =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      POST(
        new Request("https://vestiarion.invalid/api/v1/invoices", {
          method: "POST",
          headers: { authorization: "Bearer vxk_test", "content-type": "application/json", ...headers },
          body: typeof body === "string" ? body : JSON.stringify(body),
        })
      )
    );
  return { fake, send };
}

const valid = {
  counterpartyId: COUNTERPARTY,
  amount: "10.50",
  dueDate: "2026-10-31",
  memo: "Landing page design",
  poReference: "PO-7",
  goodsReceived: true,
  earlyPayDiscount: { percent: 2, deadline: "2026-10-20" },
};
const requestsTo = (requests: RecordedRequest[], path: string) => requests.filter((sent) => sent.path === path);
const invoiceInsert = (requests: RecordedRequest[]) =>
  requestsTo(requests, "/rest/v1/invoices").find((sent) => sent.method === "POST")?.body as Record<string, unknown> | undefined;

describe("POST /api/v1/invoices", () => {
  it("adds the invoice and answers 201 with it, shaped as the list returns it", async () => {
    const { fake, send } = workspace();
    const response = await send(valid);

    expect(response.status).toBe(201);
    const body = await response.json();
    // Exactly what the reference page documents for this operation.
    expect(operationById("create-invoice")!.response.parse(body)).toEqual(body);
    expect(body).toEqual({
      data: {
        id: INVOICE, direction: "payable", status: "pending", amount: 10.5, currency: "USDC", memo: "Landing page design", poReference: "PO-7",
        goodsReceived: true, dueDate: "2026-10-31T12:00:00+00:00", scheduledFor: null,
        earlyPayDiscount: { percent: 2, deadline: "2026-10-20T12:00:00+00:00" }, decidedAt: null, settledAt: null, escalatedAt: null,
        agentReasoning: null, txHash: null, paidAmount: null, counterparty: { id: COUNTERPARTY, name: "Acme Supplies", riskLevel: "clear" },
        createdAt: "2026-10-03T10:00:00Z",
      },
    });
    const readBack = requestsTo(fake.requests, "/rest/v1/invoices").find((sent) => sent.method === "GET");
    expect(readBack?.params.get("id")).toBe(`eq.${INVOICE}`);
    expect(invoiceInsert(fake.requests)).toMatchObject({
      early_pay_discount_pct: "2",
      discount_due_date: "2026-10-20T12:00:00.000Z",
      po_reference: "PO-7",
      goods_received: true,
    });
  });

  it("adds it as the key's issuer's, through the API, with the defaults a body leaves out (R4)", async () => {
    const { fake, send } = workspace();
    await send({ counterpartyId: COUNTERPARTY, amount: 10.5, dueDate: "2026-10-31" });

    expect(invoiceInsert(fake.requests)).toMatchObject({
      org_id: ORG,
      direction: "payable",
      counterparty_id: COUNTERPARTY,
      amount: "10.5",
      currency: "USDC",
      memo: null,
      po_reference: null,
      goods_received: false,
      early_pay_discount_pct: null,
      discount_due_date: null,
      created_by: ISSUER,
    });
    const entry = requestsTo(fake.requests, "/rest/v1/rpc/append_ledger_entry")[0]?.body as { p_action: string; p_detail: Record<string, unknown> };
    expect(entry.p_action).toBe("create_invoice");
    expect(entry.p_detail).toMatchObject({ by: ISSUER, via: "api", apiKeyId: key.keyId });
  });

  it.each([
    ["sandbox", true],
    ["live", false],
  ] as const)("starts the agent's cycle for a payable in a %s workspace, as the issuer", async (mode, sandbox) => {
    const { send } = workspace({ mode });
    expect((await send(valid)).status).toBe(201);
    expect(cycleMock).toHaveBeenCalledExactlyOnceWith({ orgId: ORG, userId: ISSUER, sandbox, kind: "invoice_added" });
  });

  it("starts no cycle for a receivable: the agent has nothing to pay", async () => {
    const { fake, send } = workspace();
    expect((await send({ ...valid, direction: "receivable", earlyPayDiscount: undefined })).status).toBe(201);
    expect(invoiceInsert(fake.requests)).toMatchObject({ direction: "receivable" });
    expect(cycleMock).not.toHaveBeenCalled();
  });

  it("answers 400 to a counterparty the workspace does not hold, looked up in the key's workspace only, and adds nothing (Review focus 3)", async () => {
    const { fake, send } = workspace({ counterparties: [] });
    const response = await send(valid);

    expect(response.status).toBe(400);
    const answer = (await response.json()) as { error: { code: string; message: string } };
    expect(answer.error).toEqual({ code: "invalid_request", message: "counterpartyId: No counterparty with this id in this workspace." });
    const [lookup] = requestsTo(fake.requests, "/rest/v1/counterparties");
    expect(carriesOrg(lookup, ORG)).toBe(true);
    expect(invoiceInsert(fake.requests)).toBeUndefined();
    expect(requestsTo(fake.requests, "/rest/v1/rpc/append_ledger_entry")).toEqual([]);
    expect(cycleMock).not.toHaveBeenCalled();
  });

  it("remembers that 400 under its Idempotency-Key, since the write had started (R5)", async () => {
    const { fake, send } = workspace({ counterparties: [] });
    await send(valid, { "idempotency-key": "inv-unknown" });

    const stored = requestsTo(fake.requests, "/rest/v1/api_idempotency").find((sent) => sent.method === "PATCH");
    expect(stored?.body).toMatchObject({ status: 400 });
  });

  it.each([
    ["a field the API does not take", { ...valid, vendor: "Acme" }, /^vendor: /],
    ["an unknown direction", { ...valid, direction: "refund" }, /^direction: /],
    ["a counterpartyId that is not an id", { ...valid, counterpartyId: "acme" }, /^counterpartyId: /],
    ["an amount with more than 6 decimal places", { ...valid, amount: "1.0000001" }, /^amount: Use a positive amount with at most 6 decimal places/],
    ["a zero amount", { ...valid, amount: 0 }, /^amount: /],
    ["a currency it does not take", { ...valid, currency: "BTC" }, /^currency: /],
    ["a due date that is not YYYY-MM-DD", { ...valid, dueDate: "31/10/2026" }, /^dueDate: Use a YYYY-MM-DD due date/],
    ["a due date that is not a real day", { ...valid, dueDate: "2026-02-30" }, /^dueDate: /],
    ["a discount without its deadline", { ...valid, earlyPayDiscount: { percent: 2 } }, /^earlyPayDiscount\.deadline: /],
    ["a discount of 100 percent", { ...valid, earlyPayDiscount: { percent: 100, deadline: "2026-10-20" } }, /^earlyPayDiscount\.percent: /],
    ["a discount deadline after the due date", { ...valid, earlyPayDiscount: { percent: 2, deadline: "2026-11-05" } }, /^earlyPayDiscount\.deadline: The discount deadline must be on or before the due date/],
    ["a discount deadline that is not a real day", { ...valid, earlyPayDiscount: { percent: 2, deadline: "2026-02-30" } }, /^earlyPayDiscount\.deadline: /],
  ])("answers 400 to %s, naming the field, and writes and remembers nothing", async (_label, body, message) => {
    const { fake, send } = workspace();
    const response = await send(body, { "idempotency-key": "inv-1" });

    expect(response.status).toBe(400);
    const answer = (await response.json()) as { error: { code: string; message: string } };
    expect(answer.error.code).toBe("invalid_request");
    expect(answer.error.message).toMatch(message);
    expect(requestsTo(fake.requests, "/rest/v1/invoices")).toEqual([]);
    expect(requestsTo(fake.requests, "/rest/v1/api_idempotency")).toEqual([]);
    expect(cycleMock).not.toHaveBeenCalled();
  });

  it("answers 403 to a read-only key, and writes nothing", async () => {
    useKey({ scopes: ["read"] });
    const { fake, send } = workspace();
    expect((await send(valid)).status).toBe(403);
    expect(requestsTo(fake.requests, "/rest/v1/invoices")).toEqual([]);
  });
});
