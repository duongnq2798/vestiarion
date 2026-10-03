import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as addCounterparty } from "@/app/api/v1/counterparties/route";
import { GET as listInvoices, POST as addInvoice } from "@/app/api/v1/invoices/route";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { authenticateApiKey, type AuthenticatedKey } from "@/lib/platform/api-keys";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * A write key acts for its issuer as they are now (docs/superpowers/specs/2026-10-03-write-api-part-2-design.md W5):
 * every write reads the issuer's membership again, and an issuer who can no longer add records, or is no longer a
 * member, is refused with 403 before anything is written or remembered. Reading is unchanged.
 */

const { cycleMock } = vi.hoisted(() => ({ cycleMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: cycleMock, raiseCycleEvent: vi.fn() }));
vi.mock("@/lib/compliance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/compliance")>()),
  screenCounterparty: vi.fn(async () => ({ riskLevel: "clear" })),
}));
vi.mock("@/lib/platform/api-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/api-keys")>();
  return { ...actual, authenticateApiKey: vi.fn(), touchApiKeyUsed: vi.fn(async () => {}) };
});

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const ISSUER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001a1";
const REFUSED = "This key's issuer can no longer add records in this workspace.";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
let keyCounter = 0;

/** A fresh key per test, so the per-key write limit never carries over. */
function freshKey(overrides: Partial<AuthenticatedKey> = {}) {
  keyCounter += 1;
  const key: AuthenticatedKey = {
    keyId: `3c3c3c3c-0000-4000-8000-${String(keyCounter).padStart(12, "0")}`,
    orgId: ORG,
    scopes: ["read", "write"],
    createdBy: ISSUER,
    ...overrides,
  };
  vi.mocked(authenticateApiKey).mockResolvedValue(key);
  return key;
}

beforeEach(() => {
  cycleMock.mockReset();
  vi.mocked(authenticateApiKey).mockReset();
  freshKey();
});

const STORED_INVOICE = {
  id: INVOICE, direction: "payable", status: "pending", amount: "10.5", currency: "USDC", memo: null, po_reference: null,
  goods_received: false, due_date: "2026-10-31T12:00:00+00:00", scheduled_for: null, early_pay_discount_pct: null,
  discount_due_date: null, decided_at: null, settled_at: null, escalated_at: null, agent_reasoning: null, tx_ref: null,
  paid_amount: null, created_at: "2026-10-03T10:00:00Z", counterparties: { id: COUNTERPARTY, name: "Acme Supplies", risk_level: "clear" },
};

/** A workspace whose issuer holds `role` (null: not a member), or whose membership read fails. */
function workspace(issuer: { role: string | null } | "fails", mode: "sandbox" | "live" = "sandbox") {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/memberships") {
      if (issuer === "fails") return { status: 500, body: { message: "connection reset" } };
      return { body: issuer.role ? [{ role: issuer.role }] : [] };
    }
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG, { mode }) };
    if (sent.path === "/rest/v1/counterparties" && sent.method === "GET") {
      return { body: sent.params.get("id") === `eq.${COUNTERPARTY}` ? [{ id: COUNTERPARTY, name: "Acme Supplies" }] : [] };
    }
    if (sent.path === "/rest/v1/invoices" && sent.method === "POST") return { body: { id: INVOICE } };
    if (sent.path === "/rest/v1/invoices" && sent.method === "GET") return { body: sent.params.get("id") ? STORED_INVOICE : [STORED_INVOICE] };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    if (sent.path === "/rest/v1/api_idempotency" && sent.method === "POST") return { status: 201, body: [{ org_id: ORG }] };
    return { body: [] };
  });
  const run = (handler: (request: Request) => Promise<Response>, path: string, init: RequestInit = {}) =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      handler(
        new Request(`https://vestiarion.invalid${path}`, {
          ...init,
          headers: { authorization: "Bearer vxk_test", "content-type": "application/json", ...(init.headers as Record<string, string>) },
        })
      )
    );
  return { fake, run };
}

const INVOICE_BODY = JSON.stringify({ counterpartyId: COUNTERPARTY, amount: "10.50", dueDate: "2026-10-31" });
const COUNTERPARTY_BODY = JSON.stringify({ name: "Quill Studio", role: "client" });

/** Every write a refused request must not have made, or remembered. */
function writes(requests: RecordedRequest[]) {
  return requests.filter(
    (sent) =>
      sent.path === "/rest/v1/api_idempotency" ||
      sent.path === "/rest/v1/rpc/append_ledger_entry" ||
      (sent.method !== "GET" && (sent.path === "/rest/v1/invoices" || sent.path === "/rest/v1/counterparties"))
  );
}

describe("a write key acts for its issuer as they are now (W5)", () => {
  it.each(["owner", "admin"])("lets an issuer who is now %s add an invoice", async (role) => {
    const { run } = workspace({ role });
    const response = await run(addInvoice, "/api/v1/invoices", { method: "POST", body: INVOICE_BODY, headers: { "idempotency-key": "inv-1" } });
    expect(response.status).toBe(201);
  });

  it.each([
    ["now an approver", { role: "approver" }],
    ["now a viewer", { role: "viewer" }],
    ["no longer a member", { role: null }],
  ] as const)("refuses an issuer who is %s with 403, before anything is written or remembered", async (_label, issuer) => {
    for (const [handler, path, body] of [
      [addInvoice, "/api/v1/invoices", INVOICE_BODY],
      [addCounterparty, "/api/v1/counterparties", COUNTERPARTY_BODY],
    ] as const) {
      freshKey();
      const { fake, run } = workspace(issuer);
      const response = await run(handler, path, { method: "POST", body, headers: { "idempotency-key": "same-key" } });

      expect(response.status, path).toBe(403);
      expect(await response.json()).toEqual({ error: { code: "forbidden", message: REFUSED } });
      expect(writes(fake.requests), path).toEqual([]);
    }
    expect(cycleMock).not.toHaveBeenCalled();
  });

  it("refuses a key no person issued, without reading a membership", async () => {
    freshKey({ createdBy: null });
    const { fake, run } = workspace({ role: "admin" });
    const response = await run(addInvoice, "/api/v1/invoices", { method: "POST", body: INVOICE_BODY });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "forbidden", message: REFUSED } });
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/memberships")).toBe(false);
    expect(writes(fake.requests)).toEqual([]);
  });

  it("reads the issuer's membership in the key's workspace", async () => {
    const { fake, run } = workspace({ role: "admin" });
    await run(addInvoice, "/api/v1/invoices", { method: "POST", body: INVOICE_BODY });

    const membership = fake.requests.find((sent) => sent.path === "/rest/v1/memberships");
    expect(membership?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(membership?.params.get("user_id")).toBe(`eq.${ISSUER}`);
  });

  it("answers the API's own 500 when the membership cannot be read, and writes nothing", async () => {
    const { fake, run } = workspace("fails");
    const response = await run(addInvoice, "/api/v1/invoices", { method: "POST", body: INVOICE_BODY });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal", message: "The request could not be completed." } });
    expect(writes(fake.requests)).toEqual([]);
  });

  it("starts a live workspace's cycle with the mode read for the issuer", async () => {
    const { run } = workspace({ role: "admin" }, "live");
    await run(addInvoice, "/api/v1/invoices", { method: "POST", body: INVOICE_BODY });

    expect(cycleMock).toHaveBeenCalledWith({ orgId: ORG, userId: ISSUER, sandbox: false, kind: "invoice_added" });
  });

  it("still lets the same key read: an approver may read the workspace", async () => {
    const { run } = workspace({ role: "approver" });
    const response = await run(listInvoices, "/api/v1/invoices");
    expect(response.status).toBe(200);
  });
});
