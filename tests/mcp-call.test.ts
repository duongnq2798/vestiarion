import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { OPERATIONS } from "@/lib/api/openapi";
import { authenticateApiKey, type AuthenticatedKey } from "@/lib/platform/api-keys";
import { GET as getInvoices } from "@/app/api/v1/invoices/route";
import { callOperation } from "@/lib/mcp/call";
import { carriesOrg, fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * A tool call runs the operation's own route handler in-process, with the
 * caller's Authorization header, and returns the API's JSON as it is
 * (docs/superpowers/specs/2026-09-30-mcp-server-design.md, M3 and M4).
 *
 * The mocks are the ones `tests/api-key-scope.test.ts` uses: `after` is
 * recorded instead of needing a request scope, and `authenticateApiKey` is
 * told which key a request resolves to.
 */
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: () => {} };
});

const { cycleMock } = vi.hoisted(() => ({ cycleMock: vi.fn() }));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: cycleMock, raiseCycleEvent: vi.fn() }));

vi.mock("@/lib/platform/api-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/api-keys")>();
  return {
    ...actual,
    authenticateApiKey: vi.fn(actual.authenticateApiKey),
    touchApiKeyUsed: vi.fn(async () => {}),
  };
});

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k", NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key", SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters" });

const ORG_A = "0a0a0a0a-0000-4000-8000-00000000000a";
const ORG_B = "0b0b0b0b-0000-4000-8000-00000000000b";
const KEY_A: AuthenticatedKey = { keyId: "1a1a1a1a-0000-4000-8000-00000000001a", orgId: ORG_A, scopes: ["read"], createdBy: null };
const PRESENTED = `vxk_abcdefgh_${"A".repeat(43)}`;
const AUTHORIZATION = `Bearer ${PRESENTED}`;
const ORIGIN = "https://vestiarion.invalid";
const PLATFORM_PATHS = new Set(["/rest/v1/orgs", "/rest/v1/api_keys"]);
const INVOICE_ID = "9440f32c-000d-4a63-97f1-4eb6bf78439f";

function database(tables: Record<string, unknown[]> = {}) {
  return (request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs") {
      const id = request.params.get("id")?.replace(/^eq\./, "") ?? "";
      return { body: { id, slug: "org-a", name: "Org A", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } };
    }
    return { body: tables[request.path] ?? [] };
  };
}

const INVOICE_ROW = {
  id: INVOICE_ID,
  direction: "payable",
  status: "held",
  amount: 1200,
  currency: "USDC",
  memo: "Design work",
  po_reference: null,
  goods_received: true,
  due_date: "2026-10-01",
  decided_at: null,
  settled_at: null,
  escalated_at: null,
  agent_reasoning: "Over the counterparty's limit.",
  tx_ref: null,
  counterparties: null,
  created_at: "2026-09-28T00:00:00Z",
};

function tenantRequests(fake: ReturnType<typeof fakeSupabase>): RecordedRequest[] {
  return fake.requests.filter((request) => !PLATFORM_PATHS.has(request.path));
}

function inScope<T>(fake: ReturnType<typeof fakeSupabase>, run: () => Promise<T>): Promise<T> {
  return runWith({ config, db: fake.client, fetch: fake.fetch }, run);
}

afterEach(() => {
  vi.mocked(authenticateApiKey).mockReset();
  vi.restoreAllMocks();
});

describe("callOperation", () => {
  it("returns a 200 as text and as structuredContent equal to the route's own JSON", async () => {
    const tables = { "/rest/v1/invoices": [INVOICE_ROW] };
    vi.mocked(authenticateApiKey).mockResolvedValue(KEY_A);

    const direct = fakeSupabase(database(tables));
    const expected = await inScope(direct, async () => {
      const response = await getInvoices(new Request(`${ORIGIN}/api/v1/invoices?limit=5&status=held`, { headers: { authorization: AUTHORIZATION } }));
      return response.json();
    });

    const fake = fakeSupabase(database(tables));
    const result = await inScope(fake, () => callOperation("list-invoices", { limit: 5, status: "held" }, AUTHORIZATION, ORIGIN));

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(expected);
    expect((result.structuredContent as { data: Array<{ id: string }> }).data.map((invoice) => invoice.id)).toEqual([INVOICE_ID]);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(expected) }]);
    // The arguments reached the route as its query.
    const invoices = tenantRequests(fake).find((request) => request.path === "/rest/v1/invoices");
    expect(invoices?.params.get("status")).toBe("eq.held");
    expect(invoices?.params.get("limit")).toBe("6");
  });

  it("passes the caller's Authorization header to the route unchanged", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(KEY_A);
    const fake = fakeSupabase(database());
    await inScope(fake, () => callOperation("get-status", {}, AUTHORIZATION, ORIGIN));
    expect(vi.mocked(authenticateApiKey)).toHaveBeenCalledExactlyOnceWith(AUTHORIZATION);
  });

  it("returns the route's 401 as a tool error when the key is refused", async () => {
    const fake = fakeSupabase(database());
    const result = await inScope(fake, () => callOperation("get-status", {}, "Bearer vxk_notakey", ORIGIN));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ error: { code: "unauthorized", message: "A valid API key is required." } });
    expect(tenantRequests(fake)).toEqual([]);
  });

  it("returns a bad cursor as isError with the API's 400 body", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(KEY_A);
    const fake = fakeSupabase(database());
    const cursor = Buffer.from(JSON.stringify({ k: 82 })).toString("base64url");
    const result = await inScope(fake, () => callOperation("list-invoices", { cursor }, AUTHORIZATION, ORIGIN));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ error: { code: "invalid_request", message: "cursor is not valid for this endpoint." } });
    expect(tenantRequests(fake)).toEqual([]);
  });

  it("returns the API's 400 as isError for a value the schema would refuse, rather than throwing", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(KEY_A);
    const fake = fakeSupabase(database());
    const result = await inScope(fake, () => callOperation("list-invoices", { status: "bogus", limit: "abc" }, AUTHORIZATION, ORIGIN));
    expect(result.isError).toBe(true);
    expect((JSON.parse(result.content[0].text) as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("answers get_counterparty for an id the key's workspace does not hold as not_found", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(KEY_A);
    const fake = fakeSupabase(database());
    const id = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
    const result = await inScope(fake, () => callOperation("get-counterparty", { id }, AUTHORIZATION, ORIGIN));

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: { code: "not_found", message: `Counterparty "${id}" was not found.` } });
    const lookups = tenantRequests(fake);
    expect(lookups.map((request) => [request.path, request.params.get("id")])).toEqual([["/rest/v1/counterparties", `eq.${id}`]]);
    for (const request of lookups) expect(carriesOrg(request, ORG_A)).toBe(true);
  });

  it("passes an id with URL-significant characters to the route as the id itself", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(KEY_A);
    const fake = fakeSupabase(database());
    const id = "a/b?c=d";
    const result = await inScope(fake, () => callOperation("get-counterparty", { id }, AUTHORIZATION, ORIGIN));
    expect(JSON.parse(result.content[0].text)).toEqual({ error: { code: "not_found", message: `Counterparty "${id}" was not found.` } });
  });

  it.each(OPERATIONS.filter((op) => op.method === "get").map((op) => [op.id]))("%s runs its route in the key's workspace, and names only that one", async (operationId) => {
    vi.mocked(authenticateApiKey).mockResolvedValue(KEY_A);
    const fake = fakeSupabase(database());
    const args = operationId === "get-counterparty" ? { id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de" } : {};
    const result = await inScope(fake, () => callOperation(operationId, args, AUTHORIZATION, ORIGIN));

    // An empty workspace: every operation answers, and the one lookup by id is not found.
    if (operationId === "get-counterparty") expect(JSON.parse(result.content[0].text).error.code).toBe("not_found");
    else expect(result.isError, result.content[0].text).toBeUndefined();

    const tenant = tenantRequests(fake);
    expect(tenant.length).toBeGreaterThan(0);
    for (const request of tenant) {
      expect(carriesOrg(request, ORG_A), `${request.method} ${request.path}`).toBe(true);
      expect(carriesOrg(request, ORG_B)).toBe(false);
    }
  });

  it("returns a fixed message for a thrown exception, logging the operation id and nothing else", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase(database());
    // No origin: the Request cannot be built, so the call throws before any route runs.
    const result = await inScope(fake, () => callOperation("list-invoices", { status: "held" }, AUTHORIZATION, "not a url"));

    expect(result).toEqual({ content: [{ type: "text", text: "The operation failed. Try again." }], isError: true });
    expect(log).toHaveBeenCalledExactlyOnceWith("mcp tool failed", "list-invoices");
  });

  it("answers an operation id it does not know as a tool error", async () => {
    const fake = fakeSupabase(database());
    const result = await inScope(fake, () => callOperation("delete-everything", {}, AUTHORIZATION, ORIGIN));
    expect(result.isError).toBe(true);
    expect(fake.requests).toEqual([]);
  });

  it("never logs the key or an argument", async () => {
    const lines: unknown[][] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args));
    }
    vi.mocked(authenticateApiKey).mockResolvedValue(KEY_A);
    const secretArgument = "argument-that-must-not-be-logged";
    const fake = fakeSupabase(database());
    await inScope(fake, () => callOperation("list-invoices", { counterpartyId: secretArgument }, AUTHORIZATION, ORIGIN));
    await inScope(fake, () => callOperation("list-invoices", { counterpartyId: secretArgument }, AUTHORIZATION, "not a url"));

    const logged = lines.map((args) => args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(" ")).join("\n");
    expect(logged).not.toContain(PRESENTED);
    expect(logged).not.toContain(secretArgument);
  });
});

/**
 * A write tool posts its arguments as the operation's JSON body, with the `Idempotency-Key` header when one is given,
 * to the operation's own `POST` handler (docs/superpowers/specs/2026-10-03-write-api-design.md R9).
 */
describe("callOperation for a write", () => {
  const orgs = signedOrgs();
  const ISSUER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
  const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
  const KEY_W: AuthenticatedKey = { keyId: "1a1a1a1a-0000-4000-8000-00000000002b", orgId: ORG_A, scopes: ["read", "write"], createdBy: ISSUER };
  const STORED = {
    id: INVOICE_ID, direction: "payable", status: "pending", amount: "42", currency: "USDC", memo: null, po_reference: "PO-7", goods_received: true,
    due_date: "2026-10-31T12:00:00+00:00", scheduled_for: null, early_pay_discount_pct: null, discount_due_date: null, decided_at: null, settled_at: null,
    escalated_at: null, agent_reasoning: null, tx_ref: null, paid_amount: null, created_at: "2026-10-03T10:00:00Z",
    counterparties: { id: COUNTERPARTY, name: "Acme Supplies", risk_level: "clear" },
  };
  const ARGS = { counterpartyId: COUNTERPARTY, amount: "42", dueDate: "2026-10-31", poReference: "PO-7", goodsReceived: true };

  function writable() {
    return fakeSupabase((request: RecordedRequest) => {
      if (request.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG_A) };
      if (request.path === "/rest/v1/counterparties") return { body: [{ id: COUNTERPARTY, name: "Acme Supplies" }] };
      if (request.path === "/rest/v1/invoices" && request.method === "POST") return { body: { id: INVOICE_ID } };
      if (request.path === "/rest/v1/invoices") return { body: STORED };
      if (request.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
      if (request.path === "/rest/v1/api_idempotency" && request.method === "POST") return { status: 201, body: [{ org_id: ORG_A }] };
      return { body: [] };
    });
  }

  it("posts its arguments as the body, with the Idempotency-Key, and returns the 201 as structuredContent", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(KEY_W);
    const fake = writable();
    const result = await inScope(fake, () => callOperation("create-invoice", { ...ARGS, idempotencyKey: "billing-inv-7" }, AUTHORIZATION, ORIGIN));

    expect(result.isError, result.content[0].text).toBeUndefined();
    expect((result.structuredContent as { data: { id: string; status: string } }).data).toMatchObject({ id: INVOICE_ID, status: "pending" });
    const insert = fake.requests.find((request) => request.path === "/rest/v1/invoices" && request.method === "POST");
    expect(insert?.body).toMatchObject({ org_id: ORG_A, counterparty_id: COUNTERPARTY, amount: "42", po_reference: "PO-7", goods_received: true, created_by: ISSUER });
    const claim = fake.requests.find((request) => request.path === "/rest/v1/api_idempotency" && request.method === "POST");
    expect(claim?.body).toMatchObject({ org_id: ORG_A, idempotency_key: "billing-inv-7" });
    const entry = fake.requests.find((request) => request.path === "/rest/v1/rpc/append_ledger_entry")?.body as { p_detail: Record<string, unknown> };
    expect(entry.p_detail).toMatchObject({ by: ISSUER, via: "api", apiKeyId: KEY_W.keyId });
    expect(entry.p_detail).not.toHaveProperty("idempotencyKey");
  });

  it("claims no Idempotency-Key when the call gives none", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(KEY_W);
    const fake = writable();
    const result = await inScope(fake, () => callOperation("create-invoice", ARGS, AUTHORIZATION, ORIGIN));
    expect(result.isError, result.content[0].text).toBeUndefined();
    expect(fake.requests.some((request) => request.path === "/rest/v1/api_idempotency")).toBe(false);
  });

  it("returns the route's 400 for a body it refuses as a tool error the agent can correct", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(KEY_W);
    const fake = writable();
    const result = await inScope(fake, () => callOperation("create-invoice", { ...ARGS, amount: "1.0000001" }, AUTHORIZATION, ORIGIN));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: { code: "invalid_request", message: "amount: Use a positive amount with at most 6 decimal places" } });
    expect(fake.requests.some((request) => request.path === "/rest/v1/invoices")).toBe(false);
  });

  it("returns a read-only key's 403 as a tool error, and writes nothing (Review focus 5)", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(KEY_A);
    const fake = writable();
    const result = await inScope(fake, () => callOperation("create-counterparty", { name: "Quill Studio", role: "client" }, AUTHORIZATION, ORIGIN));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ error: { code: "forbidden", message: "This key cannot do that." } });
    expect(tenantRequests(fake)).toEqual([]);
  });
});
