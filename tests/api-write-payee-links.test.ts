import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/v1/payee-links/route";
import { operationById } from "@/lib/api/openapi";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { authenticateApiKey, type AuthenticatedKey } from "@/lib/platform/api-keys";
import { payeeLinkHash } from "@/lib/platform/payee-links";
import { publicOrigin } from "@/lib/public-origin";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * `POST /api/v1/payee-links` (docs/superpowers/specs/2026-10-03-write-api-part-2-design.md W1, W3): a read-and-write key
 * makes a one-time link for a vendor or contractor to enter their own address, through the same `issuePayeeLink` the
 * console runs. The link's address is in the answer only, which no cache may keep, and no outcome is kept for an
 * `Idempotency-Key`: that would store the link's secret, of which only the hash is ever stored.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/platform/api-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/api-keys")>();
  return { ...actual, authenticateApiKey: vi.fn(), touchApiKeyUsed: vi.fn(async () => {}) };
});

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const ISSUER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const PAYEE = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const CLIENT = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c11e";
const LINK = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001e1";
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
function useKey() {
  keyCounter += 1;
  key = { keyId: `5e5e5e5e-0000-4000-8000-${String(keyCounter).padStart(12, "0")}`, orgId: ORG, scopes: ["read", "write"], createdBy: ISSUER };
  vi.mocked(authenticateApiKey).mockResolvedValue(key);
}

beforeEach(() => {
  vi.mocked(authenticateApiKey).mockReset();
  useKey();
});

function workspace(options: { role?: string; linkFails?: boolean } = {}) {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/memberships") return { body: [{ role: options.role ?? "admin" }] };
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG, { mode: "live" }) };
    if (sent.path === "/rest/v1/counterparties") {
      const rows = [
        { id: PAYEE, role: "contractor" },
        { id: CLIENT, role: "client" },
      ];
      return { body: rows.filter((row) => sent.params.get("id") === `eq.${row.id}`) };
    }
    if (sent.path === "/rest/v1/rpc/create_payee_link") {
      return options.linkFails
        ? { status: 500, body: { message: "connection reset" } }
        : { body: { id: LINK, counterparty_id: PAYEE, expires_at: "2026-10-10T15:00:00+00:00" } };
    }
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const send = (body: unknown, headers: Record<string, string> = {}) =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      POST(
        new Request("https://vestiarion.invalid/api/v1/payee-links", {
          method: "POST",
          headers: { authorization: "Bearer vxk_test", "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        })
      )
    );
  return { fake, send };
}

const requestsTo = (requests: RecordedRequest[], path: string) => requests.filter((sent) => sent.path === path);

describe("POST /api/v1/payee-links", () => {
  it("makes the link as the issuer's and answers 201 with its address, once, uncached", async () => {
    const { fake, send } = workspace();
    const response = await send({ counterpartyId: PAYEE });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { data: { id: string; counterpartyId: string; url: string; expiresAt: string } };
    expect(operationById("create-payee-link")!.response.parse(body)).toEqual(body);
    expect(body.data).toMatchObject({ id: LINK, counterpartyId: PAYEE, expiresAt: "2026-10-10T15:00:00+00:00" });
    expect(body.data.url.startsWith(`${publicOrigin()}/payee/vxp_`)).toBe(true);

    const token = body.data.url.slice(body.data.url.lastIndexOf("/") + 1);
    const made = requestsTo(fake.requests, "/rest/v1/rpc/create_payee_link")[0].body as Record<string, unknown>;
    expect(made).toMatchObject({ p_org_id: ORG, p_counterparty_id: PAYEE, p_by: ISSUER, p_token_hash: payeeLinkHash(token) });
    // Only the hash leaves the process: the link is in nothing that was sent or recorded.
    expect(JSON.stringify(fake.requests)).not.toContain(token.slice(4));
    const entry = requestsTo(fake.requests, "/rest/v1/rpc/append_ledger_entry")[0].body as { p_action: string; p_detail: Record<string, unknown> };
    expect(entry.p_action).toBe("payee_link_created");
    expect(entry.p_detail).toMatchObject({ by: ISSUER, linkId: LINK, via: "api", apiKeyId: key.keyId });
  });

  it("keeps no outcome for an Idempotency-Key, so the link is never stored: a repeat makes a new link (W3)", async () => {
    const { fake, send } = workspace();
    expect((await send({ counterpartyId: PAYEE }, { "idempotency-key": "onboard-linh" })).status).toBe(201);
    expect((await send({ counterpartyId: PAYEE }, { "idempotency-key": "onboard-linh" })).status).toBe(201);

    expect(requestsTo(fake.requests, "/rest/v1/api_idempotency")).toEqual([]);
    expect(requestsTo(fake.requests, "/rest/v1/rpc/create_payee_link")).toHaveLength(2);
  });

  it.each([
    ["a client, whom the agent never pays", { counterpartyId: CLIENT }, "counterpartyId: A payee link is for a vendor or a contractor the agent pays."],
    ["a counterparty the workspace does not hold", { counterpartyId: "0b6c1c9e-4a4f-4a7e-9b1e-00000000dead" }, "counterpartyId: No counterparty with this id in this workspace."],
  ])("answers 400 to %s, and makes no link", async (_label, body, message) => {
    const { fake, send } = workspace();
    const response = await send(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message } });
    expect(requestsTo(fake.requests, "/rest/v1/rpc/create_payee_link")).toEqual([]);
  });

  it.each([
    ["a missing counterpartyId", {}, /^counterpartyId: /],
    ["a counterpartyId that is not an id", { counterpartyId: "linh" }, /^counterpartyId: /],
    ["a field the operation does not take", { counterpartyId: PAYEE, email: "linh@example.com" }, /^email: is not a field this operation takes\.$/],
  ])("answers 400 to %s, naming the field, before reading anything", async (_label, body, message) => {
    const { fake, send } = workspace();
    const response = await send(body);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(message);
    expect(requestsTo(fake.requests, "/rest/v1/counterparties")).toEqual([]);
    expect(requestsTo(fake.requests, "/rest/v1/rpc/create_payee_link")).toEqual([]);
  });

  it("answers the API's own 500 when the link cannot be made", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { send } = workspace({ linkFails: true });
    const response = await send({ counterpartyId: PAYEE });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal", message: "The request could not be completed." } });
    log.mockRestore();
  });

  it("refuses a key whose issuer can no longer add records, before anything is made (W5)", async () => {
    const { fake, send } = workspace({ role: "viewer" });
    expect((await send({ counterpartyId: PAYEE })).status).toBe(403);
    expect(requestsTo(fake.requests, "/rest/v1/rpc/create_payee_link")).toEqual([]);
  });
});
