import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getCounterparty } from "@/app/api/v1/counterparties/[id]/route";
import { GET as listCounterparties, POST as createCounterparty } from "@/app/api/v1/counterparties/route";
import { GET as getInsights } from "@/app/api/v1/insights/route";
import { GET as listInvoices, POST as createInvoice } from "@/app/api/v1/invoices/route";
import { GET as listLedger } from "@/app/api/v1/ledger/route";
import { GET as verifyLedger } from "@/app/api/v1/ledger/verify/route";
import { GET as listMilestones } from "@/app/api/v1/milestones/route";
import { GET as getStatus } from "@/app/api/v1/status/route";
import { GET as getTreasury } from "@/app/api/v1/treasury/route";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { authenticateApiKey, type AuthenticatedKey } from "@/lib/platform/api-keys";
import { Vestiarion, VestiarionError, type FetchLike, type Invoice } from "../sdk/src/index";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * The SDK against the API's own route handlers, run in this process: whatever the SDK sends, the routes read, and
 * whatever they answer, the SDK returns (TypeScript SDK design §4, "Contract").
 */

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: vi.fn(), raiseCycleEvent: vi.fn() }));
vi.mock("@/lib/platform/api-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/api-keys")>();
  return { ...actual, authenticateApiKey: vi.fn(), touchApiKeyUsed: vi.fn(async () => {}) };
});

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const ISSUER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a1";
const API_KEY = `vxk_abcdefgh_${"A".repeat(43)}`;
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
let keys = 0;
const key = (scopes: AuthenticatedKey["scopes"]): AuthenticatedKey => {
  keys += 1;
  return { keyId: `3c3c3c3c-0000-4000-8000-${String(keys).padStart(12, "0")}`, orgId: ORG, scopes, createdBy: ISSUER };
};

const ROUTES: Record<string, (request: Request) => Promise<Response>> = {
  "GET /api/v1/status": getStatus,
  "GET /api/v1/ledger": listLedger,
  "GET /api/v1/ledger/verify": verifyLedger,
  "GET /api/v1/invoices": listInvoices,
  "POST /api/v1/invoices": createInvoice,
  "GET /api/v1/counterparties": listCounterparties,
  "POST /api/v1/counterparties": createCounterparty,
  "GET /api/v1/milestones": listMilestones,
  "GET /api/v1/treasury": getTreasury,
  "GET /api/v1/insights": getInsights,
};

/** A fetch served by the app's own route handlers, in this process. */
const routeFetch: FetchLike = async (url, init) => {
  const { pathname } = new URL(url);
  const request = new Request(url, { method: init.method, headers: init.headers, body: init.body });
  const detail = /^\/api\/v1\/counterparties\/([^/]+)$/.exec(pathname);
  if (init.method === "GET" && detail) return getCounterparty(request, { params: Promise.resolve({ id: decodeURIComponent(detail[1]) }) });
  const route = ROUTES[`${init.method} ${pathname}`];
  return route ? route(request) : new Response(JSON.stringify({ error: { code: "not_found", message: "No such route." } }), { status: 404 });
};

const STORED = {
  id: INVOICE, direction: "payable", status: "pending", amount: "0.1", currency: "USDC", memo: null, po_reference: "PO-API-1", goods_received: true,
  due_date: "2026-10-03T12:00:00+00:00", scheduled_for: null, early_pay_discount_pct: null, discount_due_date: null, decided_at: null, settled_at: null,
  escalated_at: null, agent_reasoning: null, tx_ref: null, paid_amount: null, created_at: "2026-10-03T10:16:16Z",
  counterparties: { id: COUNTERPARTY, name: "API Test Vendor", risk_level: "clear" },
};

function workspace() {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/counterparties" && sent.params.get("id") === `eq.${COUNTERPARTY}`) return { body: [{ id: COUNTERPARTY, name: "API Test Vendor" }] };
    if (sent.path === "/rest/v1/invoices" && sent.method === "POST") return { body: { id: INVOICE } };
    if (sent.path === "/rest/v1/invoices" && sent.params.get("id") === `eq.${INVOICE}`) return { body: STORED };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    if (sent.path === "/rest/v1/api_idempotency" && sent.method === "POST") return { status: 201, body: [{ org_id: ORG }] };
    return { body: [] };
  });
  const sdk = new Vestiarion({ apiKey: API_KEY, baseUrl: "https://vestiarion.invalid", fetch: routeFetch, maxRetries: 0 });
  const run = <T>(call: (client: Vestiarion) => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => call(sdk));
  return { fake, run };
}

beforeEach(() => {
  vi.mocked(authenticateApiKey).mockReset();
  vi.mocked(authenticateApiKey).mockResolvedValue(key(["read"]));
});

describe("the SDK against the API's routes", () => {
  it("reads every collection and resource of an empty workspace", async () => {
    const { run } = workspace();
    const empty = { data: [], page: { nextCursor: null, hasMore: false, count: 0 } };
    expect(await run((sdk) => sdk.invoices.list())).toEqual(empty);
    expect(await run((sdk) => sdk.counterparties.list())).toEqual(empty);
    expect(await run((sdk) => sdk.milestones.list())).toEqual(empty);
    expect(await run((sdk) => sdk.ledger.list())).toEqual(empty);
    expect(await run((sdk) => sdk.status.get())).toMatchObject({ apiVersion: "v1" });
    for (const read of [(sdk: Vestiarion) => sdk.ledger.verify(), (sdk: Vestiarion) => sdk.treasury.get(), (sdk: Vestiarion) => sdk.insights.get()]) {
      await expect(run(read)).resolves.toBeTypeOf("object");
    }
  });

  it("sends a list's filters as the route reads them", async () => {
    const { fake, run } = workspace();
    await run((sdk) => sdk.invoices.list({ status: "held", limit: 5 }));
    const read = fake.requests.find((sent) => sent.path === "/rest/v1/invoices");
    expect(read?.params.get("status")).toBe("eq.held");
    expect(read?.params.get("limit")).toBe("6");
  });

  it("throws the route's 404 as a VestiarionError", async () => {
    const { run } = workspace();
    const error = await run((sdk) => sdk.counterparties.get("0b6c1c9e-4a4f-4a7e-9b1e-00000000ffff")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VestiarionError);
    expect(error).toMatchObject({ status: 404, code: "not_found" });
  });

  it("adds an invoice with a read-and-write key, sending the caller's Idempotency-Key, and returns it typed", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(key(["read", "write"]));
    const { fake, run } = workspace();
    const invoice: Invoice = await run((sdk) =>
      sdk.invoices.create({ counterpartyId: COUNTERPARTY, amount: "0.10", dueDate: "2026-10-03", poReference: "PO-API-1", goodsReceived: true }, { idempotencyKey: "billing-inv-1" })
    );
    expect(invoice).toMatchObject({ id: INVOICE, status: "pending", amount: 0.1, counterparty: { name: "API Test Vendor" } });
    const claim = fake.requests.find((sent) => sent.path === "/rest/v1/api_idempotency" && sent.method === "POST");
    expect(claim?.body).toMatchObject({ idempotency_key: "billing-inv-1" });
  });

  it("claims a fresh Idempotency-Key for a write the caller sent without one", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(key(["read", "write"]));
    const { fake, run } = workspace();
    await run((sdk) => sdk.invoices.create({ counterpartyId: COUNTERPARTY, amount: "0.10", dueDate: "2026-10-03" }));
    const claim = fake.requests.find((sent) => sent.path === "/rest/v1/api_idempotency" && sent.method === "POST");
    expect((claim?.body as { idempotency_key: string }).idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("throws a read-only key's write as forbidden, and writes nothing", async () => {
    const { fake, run } = workspace();
    const error = await run((sdk) => sdk.counterparties.create({ name: "API Test Vendor", role: "client" })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 403, code: "forbidden" });
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/counterparties")).toBe(false);
  });
});
