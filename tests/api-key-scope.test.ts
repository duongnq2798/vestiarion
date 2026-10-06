import crypto from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { currentOrgId, runWith } from "@/lib/context";
import { apiError, guardApiRequest, handleApiRequest } from "@/lib/api/guard";
import { authenticateApiKey, generateApiKey, parseApiKey, touchApiKeyUsed, type AuthenticatedKey } from "@/lib/platform/api-keys";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { GET as getCounterparties } from "@/app/api/v1/counterparties/route";
import { GET as getCounterparty } from "@/app/api/v1/counterparties/[id]/route";
import { GET as getInsights } from "@/app/api/v1/insights/route";
import { GET as getInvoices } from "@/app/api/v1/invoices/route";
import { GET as getLedger } from "@/app/api/v1/ledger/route";
import { GET as getLedgerVerify } from "@/app/api/v1/ledger/verify/route";
import { GET as getMilestones } from "@/app/api/v1/milestones/route";
import { POST as createPayeeLink } from "@/app/api/v1/payee-links/route";
import { GET as getStatus } from "@/app/api/v1/status/route";
import { GET as getTreasury } from "@/app/api/v1/treasury/route";
import { carriesOrg, fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * Every `/api/v1` route serves the workspace of the key that calls it
 * (docs/superpowers/specs/2026-09-29-api-keys-design.md, K6 and §6).
 *
 * `authenticateApiKey` is wrapped so a test can name the key a request
 * resolves to; by default it runs the real function, which is what the 401
 * cases and the end-to-end key below go through. `after` is recorded rather
 * than left to a request scope that does not exist under test, so the
 * last-use update it defers can be run and observed.
 */
const { deferred, afterThrowsOnce } = vi.hoisted(() => ({
  deferred: [] as Array<() => unknown>,
  afterThrowsOnce: { value: false },
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: () => unknown) => {
      // A runtime with no `waitUntil` makes `after` throw (Next's docs on
      // `after`); `afterThrowsOnce` simulates that for one call at a time.
      if (afterThrowsOnce.value) {
        afterThrowsOnce.value = false;
        throw new Error("after() has no waitUntil in this runtime");
      }
      deferred.push(task);
    },
  };
});

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
const KEY_B: AuthenticatedKey = { keyId: "1b1b1b1b-0000-4000-8000-00000000001b", orgId: ORG_B, scopes: ["read"], createdBy: null };
const PLATFORM_TOKEN = "api-key-scope-platform-token";
const COUNTERPARTY_ID = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
/** Well formed; `authenticateApiKey` is told which key it is in each test that uses it. */
const PRESENTED = `vxk_abcdefgh_${"A".repeat(43)}`;

function orgRow(id: string, extra: Record<string, unknown> = {}) {
  return { id, slug: id === ORG_A ? "org-a" : "org-b", name: id === ORG_A ? "Org A" : "Org B", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null, ...extra };
}

/** Both organizations' rows, looked up by id, plus whatever tenant rows a test puts in `tables`. */
function database(tables: Record<string, unknown[]> = {}, orgs: Record<string, Record<string, unknown>> = {}) {
  return (request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs") {
      const id = request.params.get("id")?.replace(/^eq\./, "") ?? "";
      return { body: orgs[id] ?? orgRow(id) };
    }
    return { body: tables[request.path] ?? [] };
  };
}

const PLATFORM_PATHS = new Set(["/rest/v1/orgs", "/rest/v1/api_keys"]);

function tenantRequests(fake: ReturnType<typeof fakeSupabase>): RecordedRequest[] {
  return fake.requests.filter((request) => !PLATFORM_PATHS.has(request.path));
}

/** The organization the tenant client's request token names. */
function tokenOrg(request: RecordedRequest): unknown {
  const jwt = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8") || "{}").org_id;
}

function call(fake: ReturnType<typeof fakeSupabase>, handler: (request: Request) => Promise<Response>, url: string, authorization?: string) {
  const request = new Request(`https://vestiarion.invalid${url}`, { headers: authorization ? { authorization } : {} });
  return runWith({ config, db: fake.client, fetch: fake.fetch }, () => handler(request));
}

async function runDeferred(fake: ReturnType<typeof fakeSupabase>) {
  const tasks = deferred.splice(0);
  await runWith({ config, db: fake.client, fetch: fake.fetch }, () => Promise.all(tasks.map((task) => task())));
}

type Route = { url: string; handler: (request: Request) => Promise<Response>; ok: number };

const ROUTES: Record<string, Route> = {
  "counterparties/route.ts": { url: "/api/v1/counterparties", handler: getCounterparties, ok: 200 },
  "counterparties/[id]/route.ts": {
    url: `/api/v1/counterparties/${COUNTERPARTY_ID}`,
    handler: (request) => getCounterparty(request, { params: Promise.resolve({ id: COUNTERPARTY_ID }) }),
    // No such counterparty in either organization.
    ok: 404,
  },
  "insights/route.ts": { url: "/api/v1/insights", handler: getInsights, ok: 200 },
  "invoices/route.ts": { url: "/api/v1/invoices", handler: getInvoices, ok: 200 },
  "ledger/route.ts": { url: "/api/v1/ledger", handler: getLedger, ok: 200 },
  "ledger/verify/route.ts": { url: "/api/v1/ledger/verify", handler: getLedgerVerify, ok: 200 },
  "milestones/route.ts": { url: "/api/v1/milestones", handler: getMilestones, ok: 200 },
  "status/route.ts": { url: "/api/v1/status", handler: getStatus, ok: 200 },
  "treasury/route.ts": { url: "/api/v1/treasury", handler: getTreasury, ok: 200 },
};
const ROUTE_CASES = Object.entries(ROUTES).map(([file, route]) => [route.url, file, route] as const);

/**
 * A route with nothing to read: only a write, which its own tests drive (tests/api-write-payee-links.test.ts). Here it
 * is held to the key check every write has.
 */
const WRITE_ONLY_ROUTES: Record<string, { url: string; handler: (request: Request) => Promise<Response> }> = {
  "payee-links/route.ts": { url: "/api/v1/payee-links", handler: createPayeeLink },
};

const previousToken = process.env.AGENT_API_TOKEN;

beforeEach(() => {
  // The platform token is configured, so a 401 for it is the v1 surface
  // refusing it, not a deployment that has none.
  process.env.AGENT_API_TOKEN = PLATFORM_TOKEN;
});

afterEach(() => {
  if (previousToken === undefined) delete process.env.AGENT_API_TOKEN;
  else process.env.AGENT_API_TOKEN = previousToken;
  vi.mocked(authenticateApiKey).mockClear();
  vi.mocked(touchApiKeyUsed).mockClear();
  deferred.length = 0;
  afterThrowsOnce.value = false;
  vi.restoreAllMocks();
});

describe("the routes under test", () => {
  it("are every /api/v1 route", () => {
    const dir = path.join(process.cwd(), "src", "app", "api", "v1");
    const walk = (at: string): string[] =>
      readdirSync(at).flatMap((name) => (statSync(path.join(at, name)).isDirectory() ? walk(path.join(at, name)) : [path.join(at, name)]));
    const files = walk(dir).filter((file) => file.endsWith("route.ts")).map((file) => path.relative(dir, file).split(path.sep).join("/"));
    // The OpenAPI document is the one public v1 route: it describes the
    // surface, holds no workspace data and takes no key (tests/openapi.test.ts).
    expect(files.filter((file) => file !== "openapi.json/route.ts").sort()).toEqual([...Object.keys(ROUTES), ...Object.keys(WRITE_ONLY_ROUTES)].sort());
  });

  it.each(Object.entries(WRITE_ONLY_ROUTES))("refuse a read-only key on %s's write with 403, reaching no workspace data (write API R7)", async (_file, route) => {
    vi.mocked(authenticateApiKey).mockResolvedValueOnce(KEY_A);
    const fake = fakeSupabase(database());
    const request = new Request(`https://vestiarion.invalid${route.url}`, {
      method: "POST",
      headers: { authorization: `Bearer ${PRESENTED}`, "content-type": "application/json" },
      body: JSON.stringify({ counterpartyId: COUNTERPARTY_ID }),
    });
    const response = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => route.handler(request));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "forbidden", message: "This key cannot do that." } });
    expect(fake.requests.filter((sent) => !PLATFORM_PATHS.has(sent.path))).toEqual([]);
  });
});

describe.each(ROUTE_CASES)("GET %s", (url, _file, route) => {
  const UNAUTHORIZED = { error: { code: "unauthorized", message: "A valid API key is required." } };

  it.each([
    ["no Authorization header", undefined],
    ["the platform token", `Bearer ${PLATFORM_TOKEN}`],
    ["a malformed key", "Bearer vxk_notakey"],
  ])("answers 401 to %s, and reads nothing", async (_label, authorization) => {
    const fake = fakeSupabase(database());
    const response = await call(fake, route.handler, url, authorization);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(UNAUTHORIZED);
    expect(fake.requests).toEqual([]);
    expect(deferred).toEqual([]);
  });

  it("answers 401 to a well-formed key with an unknown prefix, the same body as no key at all", async () => {
    // Well-formed and grammar-valid, but the fake's api_keys table is empty:
    // this is the one 401 case that reaches the database (a single lookup by
    // prefix) rather than being refused before ever asking.
    const fake = fakeSupabase(database());
    const response = await call(fake, route.handler, url, `Bearer ${PRESENTED}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(UNAUTHORIZED);
    expect(tenantRequests(fake)).toEqual([]);
    expect(deferred).toEqual([]);
  });

  it("records the key's use directly when after() throws, so a runtime without waitUntil still serves the request", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValueOnce(KEY_A);
    afterThrowsOnce.value = true;
    const fake = fakeSupabase(database());
    const response = await call(fake, route.handler, url, `Bearer ${PRESENTED}`);

    expect(response.status).toBe(route.ok);
    expect(deferred).toEqual([]);
    expect(vi.mocked(touchApiKeyUsed)).toHaveBeenCalledExactlyOnceWith(KEY_A.keyId);
  });

  it.each([
    ["A", KEY_A, ORG_B],
    ["B", KEY_B, ORG_A],
  ])("serves the workspace of a key for org %s, and only that one", async (_label, key, other) => {
    vi.mocked(authenticateApiKey).mockResolvedValueOnce(key);
    const fake = fakeSupabase(database());
    const response = await call(fake, route.handler, url, `Bearer ${PRESENTED}`);

    expect(response.status).toBe(route.ok);
    expect(vi.mocked(authenticateApiKey)).toHaveBeenCalledWith(`Bearer ${PRESENTED}`);
    const tenant = tenantRequests(fake);
    expect(tenant.length).toBeGreaterThan(0);
    for (const request of tenant) {
      expect(carriesOrg(request, key.orgId), `${request.method} ${request.path}`).toBe(true);
      expect(carriesOrg(request, other)).toBe(false);
      expect(tokenOrg(request)).toBe(key.orgId);
    }
    // The organization entered is the key's, read by its id.
    const orgLookups = fake.requests.filter((request) => request.path === "/rest/v1/orgs");
    expect(orgLookups.map((request) => request.params.get("id"))).toEqual([`eq.${key.orgId}`]);
  });

  it("records the key's use after the response, without awaiting it first", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValueOnce(KEY_A);
    const fake = fakeSupabase(database());
    await call(fake, route.handler, url, `Bearer ${PRESENTED}`);

    expect(vi.mocked(touchApiKeyUsed)).not.toHaveBeenCalled();
    await runDeferred(fake);
    expect(vi.mocked(touchApiKeyUsed)).toHaveBeenCalledExactlyOnceWith(KEY_A.keyId);
  });

  it("answers 403 to a key without the read scope, and reads nothing", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValueOnce({ ...KEY_A, scopes: [] });
    const fake = fakeSupabase(database());
    const response = await call(fake, route.handler, url, `Bearer ${PRESENTED}`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "forbidden", message: "This key cannot do that." } });
    expect(tenantRequests(fake)).toEqual([]);
  });

  it("answers 500, never 401, when the key cannot be checked", async () => {
    // The key may be valid: a database error is not a verdict on it.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(authenticateApiKey).mockRejectedValueOnce(new Error("connection to api_keys refused"));
    const fake = fakeSupabase(database());
    const response = await call(fake, route.handler, url, `Bearer ${PRESENTED}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal", message: "The request could not be completed." } });
    expect(log).toHaveBeenCalled();
    expect(tenantRequests(fake)).toEqual([]);
    expect(deferred).toEqual([]);
  });
});

/** Through the real `authenticateApiKey`, against a stored hash, with nothing mocked but the network. */
describe("a real key, end to end", () => {
  const { token, prefix, secretHash } = generateApiKey();
  const stored = { id: KEY_B.keyId, org_id: ORG_B, secret_hash: secretHash, scopes: ["read"], revoked_at: null as string | null };
  const NO_KEY_BODY = { error: { code: "unauthorized", message: "A valid API key is required." } };

  function withKey(row: typeof stored) {
    return fakeSupabase((request) =>
      request.path === "/rest/v1/api_keys"
        ? { body: request.params.get("prefix") === `eq.${prefix}` ? [row] : [] }
        : database()(request)
    );
  }

  it("serves the key's workspace, looking the key up by its prefix alone", async () => {
    const fake = withKey(stored);
    const response = await call(fake, getStatus, "/api/v1/status", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { businessName: string } }).data.businessName).toBe("Org B");
    const lookups = fake.requests.filter((request) => request.path === "/rest/v1/api_keys");
    expect(lookups).toHaveLength(1);
    expect(lookups[0].params.toString()).not.toContain(parseApiKey(token)!.secret);
    for (const request of tenantRequests(fake)) expect(carriesOrg(request, ORG_B)).toBe(true);
  });

  it("answers 401 to a revoked key, with the same body as no key at all", async () => {
    const fake = withKey({ ...stored, revoked_at: "2026-09-29T00:00:00Z" });
    const response = await call(fake, getStatus, "/api/v1/status", `Bearer ${token}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(NO_KEY_BODY);
    expect(tenantRequests(fake)).toEqual([]);
  });

  it("answers 401 to an unknown prefix, with the same body as no key at all", async () => {
    const fake = withKey(stored);
    const other = generateApiKey();
    const response = await call(fake, getStatus, "/api/v1/status", `Bearer ${other.token}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(NO_KEY_BODY);
    expect(tenantRequests(fake)).toEqual([]);
  });

  it("answers 500, never 401, when the lookup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase((request) =>
      request.path === "/rest/v1/api_keys" ? { status: 500, body: { message: "database unavailable" } } : database()(request)
    );
    const response = await call(fake, getStatus, "/api/v1/status", `Bearer ${token}`);
    expect(response.status).toBe(500);
    expect(tenantRequests(fake)).toEqual([]);
  });
});

describe("guardApiRequest", () => {
  it("returns the key it authenticated", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValueOnce(KEY_A);
    const fake = fakeSupabase(database());
    const request = new Request("https://vestiarion.invalid/api/v1/status", { headers: { authorization: `Bearer ${PRESENTED}` } });
    const guard = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => guardApiRequest(request, { scope: "read" }));
    expect(guard).toEqual({ key: KEY_A });
  });

  const writeRequest = () =>
    new Request("https://vestiarion.invalid/api/v1/invoices", { method: "POST", headers: { authorization: `Bearer ${PRESENTED}` } });
  const guardWrite = (fake: ReturnType<typeof fakeSupabase>) =>
    runWith({ config, db: fake.client, fetch: fake.fetch }, () => guardApiRequest(writeRequest(), { scope: "write" }));

  it("answers 403 to a read-only key on a write (write API R7)", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValueOnce(KEY_A);
    const guard = await guardWrite(fakeSupabase(database()));
    expect("denied" in guard && guard.denied.status).toBe(403);
  });

  it("lets one key write 30 times a minute, then answers 429 with Retry-After, while another key still writes (write API R6)", async () => {
    const busy: AuthenticatedKey = { ...KEY_A, keyId: "3c3c3c3c-0000-4000-8000-00000000003c", scopes: ["read", "write"] };
    const other: AuthenticatedKey = { ...KEY_B, keyId: "4d4d4d4d-0000-4000-8000-00000000004d", scopes: ["read", "write"] };
    const fake = fakeSupabase(database());
    vi.mocked(authenticateApiKey).mockResolvedValue(busy);
    for (let i = 0; i < 30; i++) expect(await guardWrite(fake)).toEqual({ key: busy });
    const refused = await guardWrite(fake);
    expect("denied" in refused && refused.denied.status).toBe(429);
    expect("denied" in refused && refused.denied.headers.get("Retry-After")).toBe("60");
    vi.mocked(authenticateApiKey).mockResolvedValue(other);
    expect(await guardWrite(fake)).toEqual({ key: other });
    vi.mocked(authenticateApiKey).mockReset();
  });

  it("answers a conflict with 409 (write API R5, R7)", () => {
    expect(apiError("conflict", "That Idempotency-Key was used for another request.").status).toBe(409);
  });
});

describe("handleApiRequest", () => {
  it("runs the handler in the key's organization", async () => {
    const fake = fakeSupabase(database());
    const response = await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      handleApiRequest("test", KEY_B, async () => ({ orgId: currentOrgId() }))
    );
    expect(await response.json()).toEqual({ orgId: ORG_B });
  });

  it("sends a coded error the handler settles on inside that scope as it is", async () => {
    const fake = fakeSupabase(database());
    const response = await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      handleApiRequest("test", KEY_A, async () => apiError("not_found", "Nothing here."))
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "Nothing here." } });
  });

  it("answers a throw with the generic internal error and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase(database());
    const response = await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      handleApiRequest("test", KEY_A, async () => {
        throw new Error("relation secret_table does not exist");
      })
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal", message: "The request could not be completed." } });
    expect(log).toHaveBeenCalledWith("[api] test failed", expect.any(Error));
  });
});

/**
 * The one v1 route that looks a caller-supplied id up. The lookup happens
 * inside `handleApiRequest`, in the key's organization.
 */
describe("GET /api/v1/counterparties/{id}", () => {
  async function get(fake: ReturnType<typeof fakeSupabase>) {
    vi.mocked(authenticateApiKey).mockResolvedValueOnce(KEY_A);
    return call(
      fake,
      (request) => getCounterparty(request, { params: Promise.resolve({ id: COUNTERPARTY_ID }) }),
      `/api/v1/counterparties/${COUNTERPARTY_ID}`,
      `Bearer ${PRESENTED}`
    );
  }

  it("answers an id the key's organization does not hold as not found", async () => {
    const fake = fakeSupabase(database());
    const response = await get(fake);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: `Counterparty "${COUNTERPARTY_ID}" was not found.` } });
    expect(tenantRequests(fake).map((request) => [request.path, request.params.get("id")])).toEqual([
      ["/rest/v1/counterparties", `eq.${COUNTERPARTY_ID}`],
    ]);
    for (const request of tenantRequests(fake)) expect(carriesOrg(request, ORG_A)).toBe(true);
  });

  it("serves one it does hold, with its screening history, asking only within that organization", async () => {
    const fake = fakeSupabase(
      database({
        "/rest/v1/counterparties": [{ id: COUNTERPARTY_ID, name: "Priya Raman", role: "contractor", risk_level: "clear", created_at: "2026-09-28T00:00:00Z" }],
        "/rest/v1/compliance_checks": [{ id: "check-1", risk_level: "clear", source: "bundled", screening_mode: "simulate", status: "complete", created_at: "2026-09-28T00:00:00Z" }],
      })
    );
    const response = await get(fake);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string; screeningHistory: Array<{ id: string }> } };
    expect(body.data.id).toBe(COUNTERPARTY_ID);
    expect(body.data.screeningHistory.map((check) => check.id)).toEqual(["check-1"]);
    expect(tenantRequests(fake).map((request) => request.path)).toEqual(["/rest/v1/counterparties", "/rest/v1/compliance_checks"]);
    for (const request of tenantRequests(fake)) expect(carriesOrg(request, ORG_A)).toBe(true);
  });
});

/**
 * An organization whose Circle credentials are stored but cannot be read
 * refuses to pay rather than fall back to simulation (R12). Status must say
 * that, not report payments as simulated — a client reading `simulate` would
 * expect a cycle to settle invoices, and none will.
 */
describe("GET /api/v1/status", () => {
  const previousMasterKeys = process.env.VESTIARION_MASTER_KEYS;

  afterEach(() => {
    if (previousMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
    else process.env.VESTIARION_MASTER_KEYS = previousMasterKeys;
  });

  async function status(row: Record<string, unknown>) {
    vi.mocked(authenticateApiKey).mockResolvedValueOnce(KEY_A);
    const fake = fakeSupabase(database({}, { [ORG_A]: row }));
    const response = await call(fake, getStatus, "/api/v1/status", `Bearer ${PRESENTED}`);
    return { response, body: (await response.json()) as { data: { businessName: string; provenance: Record<string, string> } } };
  }

  it("reports payments and yield as unavailable when the stored Circle credentials cannot be read", async () => {
    // Sealed under a master key this deployment no longer holds.
    const retired = parseMasterKeys(`retired:${crypto.randomBytes(32).toString("base64")}`);
    process.env.VESTIARION_MASTER_KEYS = `current:${crypto.randomBytes(32).toString("base64")}`;
    const { response, body } = await status(
      orgRow(ORG_A, {
        circle_api_key_enc: encryptSecret("circle-key", { orgId: ORG_A, column: "circle_api_key_enc" }, retired),
        circle_entity_secret_enc: encryptSecret("entity-secret", { orgId: ORG_A, column: "circle_entity_secret_enc" }, retired),
      })
    );

    expect(response.status).toBe(200);
    expect(body.data.provenance).toEqual({ payments: "unavailable", yield: "unavailable", screening: "simulate" });
  });

  it("reports payments and yield as unavailable for a workspace on Arc mainnet with no Circle account yet (mainnet limits L7)", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValueOnce(KEY_A);
    const fake = fakeSupabase(database({}, { [ORG_A]: orgRow(ORG_A, { network: "arc-mainnet" }) }));
    const request = new Request("https://vestiarion.invalid/api/v1/status", { headers: { authorization: `Bearer ${PRESENTED}` } });
    const response = await runWith({ config: { ...config, mainnetEnabled: true }, db: fake.client, fetch: fake.fetch }, () => getStatus(request));
    const body = (await response.json()) as { data: { provenance: Record<string, string> } };
    expect(body.data.provenance).toEqual({ payments: "unavailable", yield: "unavailable", screening: "simulate" });
  });

  it("reports payments and yield as unavailable for a live, connected workspace on Arc mainnet while the deployment has it switched off (mainnet limits L7)", async () => {
    const current = `current:${crypto.randomBytes(32).toString("base64")}`;
    process.env.VESTIARION_MASTER_KEYS = current;
    const row = orgRow(ORG_A, {
      network: "arc-mainnet",
      wallet_host: "own",
      circle_api_key_enc: encryptSecret("circle-key", { orgId: ORG_A, column: "circle_api_key_enc" }, parseMasterKeys(current)),
      circle_entity_secret_enc: encryptSecret("entity-secret", { orgId: ORG_A, column: "circle_entity_secret_enc" }, parseMasterKeys(current)),
    });
    const provenance = async (mainnetEnabled: boolean) => {
      vi.mocked(authenticateApiKey).mockResolvedValueOnce(KEY_A);
      const fake = fakeSupabase(database({}, { [ORG_A]: row }));
      const request = new Request("https://vestiarion.invalid/api/v1/status", { headers: { authorization: `Bearer ${PRESENTED}` } });
      const response = await runWith({ config: { ...config, mainnetEnabled }, db: fake.client, fetch: fake.fetch }, () => getStatus(request));
      return ((await response.json()) as { data: { provenance: Record<string, string> } }).data.provenance;
    };

    expect(await provenance(false)).toEqual({ payments: "unavailable", yield: "unavailable", screening: "simulate" });
    // The same workspace with the switch on pays live, so it is the switch that holds it.
    expect((await provenance(true)).payments).toBe("live");
  });

  it("reports the key's own workspace, and simulate when it has no Circle credentials stored", async () => {
    const { body } = await status(orgRow(ORG_A));
    expect(body.data.businessName).toBe("Org A");
    expect(body.data.provenance).toEqual({ payments: "simulate", yield: "simulate", screening: "simulate" });
  });

  it("does not expose platform-level database configuration to a workspace", async () => {
    const { body } = await status(orgRow(ORG_A));
    const configuration = (body.data as unknown as { configuration: Record<string, unknown> }).configuration;
    expect(configuration).not.toHaveProperty("database");
    expect(JSON.stringify(configuration)).not.toContain("tests.supabase.invalid");
  });
});

describe("a cursor this endpoint did not issue", () => {
  const cursorOf = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const INVOICE_CURSOR = cursorOf({ k: "2026-09-24T15:22:50.176754+00:00", id: "9440f32c-000d-4a63-97f1-4eb6bf78439f" });
  const LEDGER_CURSOR = cursorOf({ k: 82 });
  const INVALID = { error: { code: "invalid_request", message: "cursor is not valid for this endpoint." } };

  const collections: Array<[string, (request: Request) => Promise<Response>, string[]]> = [
    ["/api/v1/ledger", getLedger, [INVOICE_CURSOR, cursorOf({ k: "abc" }), cursorOf({ k: -1 }), cursorOf({ k: 1.5 }), cursorOf({ k: "82" })]],
    ["/api/v1/invoices", getInvoices, [LEDGER_CURSOR, cursorOf({ k: "abc", id: "x" }), cursorOf({ k: "2026-09-24T15:22:50Z", id: "not-a-uuid" }), cursorOf({ k: "2026-09-24T15:22:50Z),id.gt.(0", id: "9440f32c-000d-4a63-97f1-4eb6bf78439f" })]],
    ["/api/v1/counterparties", getCounterparties, [LEDGER_CURSOR, cursorOf({ k: "abc", id: "x" })]],
    ["/api/v1/milestones", getMilestones, [LEDGER_CURSOR, cursorOf({ k: "abc", id: "x" })]],
  ];

  it.each(collections)("%s answers 400 to a foreign or forged cursor, and never reaches the tenant database", async (url, handler, cursors) => {
    for (const cursor of cursors) {
      vi.mocked(authenticateApiKey).mockResolvedValueOnce(KEY_A);
      const fake = fakeSupabase(database());
      const response = await call(fake, handler, `${url}?cursor=${cursor}`, `Bearer ${PRESENTED}`);
      expect(response.status, cursor).toBe(400);
      expect(await response.json()).toEqual(INVALID);
      expect(tenantRequests(fake), cursor).toEqual([]);
    }
  });

  it.each([
    ["/api/v1/ledger", getLedger, LEDGER_CURSOR],
    ["/api/v1/invoices", getInvoices, INVOICE_CURSOR],
    ["/api/v1/counterparties", getCounterparties, INVOICE_CURSOR],
    ["/api/v1/milestones", getMilestones, INVOICE_CURSOR],
  ] as const)("%s still accepts a cursor of its own shape", async (url, handler, cursor) => {
    vi.mocked(authenticateApiKey).mockResolvedValueOnce(KEY_A);
    const fake = fakeSupabase(database());
    const response = await call(fake, handler, `${url}?cursor=${cursor}`, `Bearer ${PRESENTED}`);
    expect(response.status).toBe(200);
  });
});
