import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/v1/counterparties/route";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { authenticateApiKey, type AuthenticatedKey } from "@/lib/platform/api-keys";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * `POST /api/v1/counterparties` (docs/superpowers/specs/2026-10-03-write-api-design.md R2, R3, R5, R7): a
 * read-and-write key adds a counterparty, screened like one added in the console. An address it sets waits for a
 * person's confirmation. A body that does not validate is answered with 400, naming the field, before anything is
 * written or remembered.
 */

const { screenMock } = vi.hoisted(() => ({ screenMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/compliance", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/compliance")>()), screenCounterparty: screenMock }));
vi.mock("@/lib/platform/api-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/api-keys")>();
  return { ...actual, authenticateApiKey: vi.fn(), touchApiKeyUsed: vi.fn(async () => {}) };
});

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const ISSUER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const CREATED = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const ADDRESS = `0x${"ab".repeat(20)}`;
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
let keyCounter = 0;

/** A fresh key per test, so the per-key write limit never carries over. */
function writeKey(overrides: Partial<AuthenticatedKey> = {}): AuthenticatedKey {
  keyCounter += 1;
  return { keyId: `1a1a1a1a-0000-4000-8000-${String(keyCounter).padStart(12, "0")}`, orgId: ORG, scopes: ["read", "write"], createdBy: ISSUER, ...overrides };
}

beforeEach(() => {
  screenMock.mockReset();
  screenMock.mockResolvedValue({ riskLevel: "clear" });
  vi.mocked(authenticateApiKey).mockReset();
  vi.mocked(authenticateApiKey).mockResolvedValue(writeKey());
});

const STORED = {
  id: CREATED, name: "Quill Studio", role: "vendor", address: ADDRESS, chain: "ARC-TESTNET", jurisdiction: "VN", risk_level: "clear", risk_notes: null,
  baseline_payment_limit: "25", payment_limit: "25", last_screened_at: "2026-10-03T10:00:01Z", performance_score: null, performance_inputs: null,
  created_at: "2026-10-03T10:00:00Z",
};

function workspace() {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/counterparties" && sent.method === "POST") return { body: { id: CREATED, name: "Quill Studio" } };
    if (sent.path === "/rest/v1/counterparties" && sent.method === "GET") return { body: STORED };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    if (sent.path === "/rest/v1/api_idempotency" && sent.method === "POST") return { status: 201, body: [{ org_id: ORG }] };
    return { body: [] };
  });
  const send = (body: string, headers: Record<string, string> = {}) =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      POST(new Request("https://vestiarion.invalid/api/v1/counterparties", { method: "POST", headers: { authorization: "Bearer vxk_test", "content-type": "application/json", ...headers }, body }))
    );
  return { fake, send };
}

const valid = { name: "Quill Studio", role: "vendor", address: ADDRESS, jurisdiction: "VN", paymentLimit: 25 };
const requestsTo = (requests: RecordedRequest[], path: string) => requests.filter((sent) => sent.path === path);

describe("POST /api/v1/counterparties", () => {
  it("adds the counterparty and answers 201 with it, shaped as the list returns it", async () => {
    const { send } = workspace();
    const response = await send(JSON.stringify(valid));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      data: {
        id: CREATED, name: "Quill Studio", role: "vendor", address: ADDRESS, chain: "ARC-TESTNET", jurisdiction: "VN", riskLevel: "clear", riskNotes: null,
        baselinePaymentLimit: 25, paymentLimit: 25, lastScreenedAt: "2026-10-03T10:00:01Z", performanceScore: null, performanceInputs: null,
        createdAt: "2026-10-03T10:00:00Z",
      },
    });
    expect(screenMock).toHaveBeenCalledWith(CREATED);
  });

  it("stores the address as a change waiting for a person, and records the write as the issuer's through the API (Review focus 1)", async () => {
    const { fake, send } = workspace();
    await send(JSON.stringify(valid));

    const insert = requestsTo(fake.requests, "/rest/v1/counterparties").find((sent) => sent.method === "POST")?.body as Record<string, unknown>;
    expect(insert).toMatchObject({ org_id: ORG, address: ADDRESS, address_changed_at: expect.any(String), baseline_payment_limit: "25" });
    expect(insert).not.toHaveProperty("address_confirmed_at");
    const entry = requestsTo(fake.requests, "/rest/v1/rpc/append_ledger_entry")[0]?.body as { p_detail: Record<string, unknown> };
    expect(entry.p_detail).toMatchObject({ by: ISSUER, via: "api", addressNeedsConfirmation: true });
  });

  it.each([
    ["a field the API does not take", { ...valid, nickname: "Q" }, /^nickname: /],
    ["an unknown role", { ...valid, role: "partner" }, /^role: /],
    ["an address that is not a 0x address", { ...valid, address: "0x123" }, /^address: Use a 0x address of 40 hex characters/],
    ["a vendor with no payment limit", { name: "Quill Studio", role: "vendor" }, /^paymentLimit: /],
    ["a contractor on another chain", { ...valid, role: "contractor", chain: "BASE-SEPOLIA" }, /^chain: Only a vendor/],
  ])("answers 400 to %s, naming the field, and writes and remembers nothing", async (_label, body, message) => {
    const { fake, send } = workspace();
    const response = await send(JSON.stringify(body), { "idempotency-key": "cp-1" });

    expect(response.status).toBe(400);
    const answer = (await response.json()) as { error: { code: string; message: string } };
    expect(answer.error.code).toBe("invalid_request");
    expect(answer.error.message).toMatch(message);
    expect(requestsTo(fake.requests, "/rest/v1/counterparties")).toEqual([]);
    expect(requestsTo(fake.requests, "/rest/v1/api_idempotency")).toEqual([]);
  });

  it.each([
    ["a body that is not JSON", "{name:"],
    ["a body over 64 KB", JSON.stringify({ ...valid, name: "x".repeat(70_000) })],
  ])("answers 400 to %s before reading anything else (Review focus 4)", async (_label, body) => {
    const { fake, send } = workspace();
    const response = await send(body);
    expect(response.status).toBe(400);
    expect(requestsTo(fake.requests, "/rest/v1/counterparties")).toEqual([]);
  });

  it("answers 403 to a read-only key, and writes nothing", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(writeKey({ scopes: ["read"] }));
    const { fake, send } = workspace();
    expect((await send(JSON.stringify(valid))).status).toBe(403);
    expect(requestsTo(fake.requests, "/rest/v1/counterparties")).toEqual([]);
  });
});
