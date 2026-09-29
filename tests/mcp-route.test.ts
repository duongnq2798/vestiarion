import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { authenticateApiKey, generateApiKey, type AuthenticatedKey } from "@/lib/platform/api-keys";
import { MCP_TOOLS } from "@/lib/mcp/tools";
import { GET as verifyLedgerRoute } from "@/app/api/v1/ledger/verify/route";
import { DELETE, GET, POST } from "@/app/api/mcp/route";
import { carriesOrg, fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * The remote MCP server at `/api/mcp`
 * (docs/superpowers/specs/2026-09-30-mcp-server-design.md, M1–M4 and M8).
 *
 * The exported handlers are driven with `Request` objects, as Next calls
 * them. A key is checked before any MCP processing: `createMcpHandler` is
 * wrapped so a test can see whether a request ever reached it. The other
 * mocks are the ones `tests/api-key-scope.test.ts` uses.
 */
const { reached } = vi.hoisted(() => ({ reached: { count: 0 } }));

vi.mock("mcp-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mcp-handler")>();
  return {
    ...actual,
    createMcpHandler: (...args: Parameters<typeof actual.createMcpHandler>) => {
      const handler = actual.createMcpHandler(...args);
      return (request: Request) => {
        reached.count += 1;
        return handler(request);
      };
    },
  };
});

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: () => {} };
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
const KEY_A: AuthenticatedKey = { keyId: "1a1a1a1a-0000-4000-8000-00000000001a", orgId: ORG_A, scopes: ["read"] };
/** Well formed; `authenticateApiKey` is told which key it is in each test that uses it. */
const PRESENTED = `vxk_abcdefgh_${"A".repeat(43)}`;
const AUTHORIZATION = `Bearer ${PRESENTED}`;
const PLATFORM_TOKEN = "mcp-route-platform-token";
const ORIGIN = "https://vestiarion.invalid";
const PLATFORM_PATHS = new Set(["/rest/v1/orgs", "/rest/v1/api_keys"]);
const CHALLENGE = 'Bearer realm="vestiarion"';
const UNAUTHORIZED = { error: { code: "unauthorized", message: "A valid API key is required." } };
const MODERN = "2026-07-28";

function orgRow(id: string) {
  return { id, slug: id === ORG_A ? "org-a" : "org-b", name: id === ORG_A ? "Org A" : "Org B", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
}

function database(tables: Record<string, unknown[]> = {}) {
  return (request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow(request.params.get("id")?.replace(/^eq\./, "") ?? "") };
    return { body: tables[request.path] ?? [] };
  };
}

function tenantRequests(fake: ReturnType<typeof fakeSupabase>): RecordedRequest[] {
  return fake.requests.filter((request) => !PLATFORM_PATHS.has(request.path));
}

type Fake = ReturnType<typeof fakeSupabase>;

interface JsonRpcReply {
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface CallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface Message {
  body: unknown;
  headers: Record<string, string>;
}

/** A 2025-era client: a plain JSON-RPC body, and after `initialize` the negotiated version as a header. */
function legacyRequest(body: Record<string, unknown>, version?: string): Message {
  return {
    body: { jsonrpc: "2.0", ...body },
    headers: version ? { "mcp-protocol-version": version } : {},
  };
}

/** A 2026-07-28 client: the per-request `_meta` envelope, and the headers that must agree with it. */
function modernRequest(body: { id: number; method: string; params?: Record<string, unknown> }): Message {
  const params = body.params ?? {};
  const meta = {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientInfo": { name: "mcp-route-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  return {
    body: { jsonrpc: "2.0", id: body.id, method: body.method, params: { ...params, _meta: meta } },
    headers: {
      "mcp-protocol-version": MODERN,
      "mcp-method": body.method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
    },
  };
}

function send(
  handler: (request: Request) => Promise<Response>,
  fake: Fake,
  { body, headers = {}, authorization, url = "/api/mcp", method = "POST" }: { body?: unknown; headers?: Record<string, string>; authorization?: string; url?: string; method?: string }
) {
  const request = new Request(`${ORIGIN}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization ? { authorization } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return runWith({ config, db: fake.client, fetch: fake.fetch }, () => handler(request));
}

/** `null` sends no Authorization header at all. */
function post(fake: Fake, message: Message, authorization: string | null = AUTHORIZATION) {
  return send(POST, fake, { ...message, authorization: authorization ?? undefined });
}

/** The one JSON-RPC message in a response, whether sent as JSON or as a single SSE event. */
async function reply(response: Response): Promise<JsonRpcReply> {
  const text = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(text) as JsonRpcReply;
  const data = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice("data: ".length));
  expect(data).toHaveLength(1);
  return JSON.parse(data[0]) as JsonRpcReply;
}

const ERAS = [
  ["2025-06-18", (id: number, method: string, params?: Record<string, unknown>) => legacyRequest({ id, method, params: params ?? {} }, "2025-06-18")],
  [MODERN, (id: number, method: string, params?: Record<string, unknown>) => modernRequest({ id, method, params })],
] as const;

const previousToken = process.env.AGENT_API_TOKEN;
const actualKeys = await vi.importActual<typeof import("@/lib/platform/api-keys")>("@/lib/platform/api-keys");

beforeEach(() => {
  reached.count = 0;
  // The real lookup, unless a test names the key a request resolves to.
  vi.mocked(authenticateApiKey).mockReset().mockImplementation(actualKeys.authenticateApiKey);
  // The platform token is configured, so a 401 for it is this route refusing
  // it, not a deployment that has none.
  process.env.AGENT_API_TOKEN = PLATFORM_TOKEN;
});

afterEach(() => {
  if (previousToken === undefined) delete process.env.AGENT_API_TOKEN;
  else process.env.AGENT_API_TOKEN = previousToken;
  vi.restoreAllMocks();
});

describe("the route's configuration", () => {
  it("runs per request, for up to 60 seconds", async () => {
    const route = await import("@/app/api/mcp/route");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBe(60);
  });
});

describe("the key check, before any MCP processing", () => {
  const INITIALIZE = legacyRequest({ id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t", version: "1" } } });

  function expectRefused(response: Response, status = 401) {
    expect(response.status).toBe(status);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer realm="vestiarion"/);
    expect(reached.count).toBe(0);
  }

  it.each([
    ["no Authorization header", null],
    ["a malformed key", "Bearer vxk_notakey"],
    ["the platform token", `Bearer ${PLATFORM_TOKEN}`],
    ["a key sent with another scheme", `Basic ${PRESENTED}`],
  ])("answers 401 to %s, with the API's error body, and reads nothing", async (_label, authorization) => {
    const fake = fakeSupabase(database());
    const response = await post(fake, INITIALIZE, authorization);
    expectRefused(response);
    expect(response.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(await response.json()).toEqual(UNAUTHORIZED);
    expect(fake.requests).toEqual([]);
  });

  describe("with the real key lookup, against a stored hash", () => {
    const { token, prefix, secretHash } = generateApiKey();
    const stored = { id: KEY_A.keyId, org_id: ORG_B, secret_hash: secretHash, scopes: ["read"], revoked_at: null as string | null };

    function withKey(row: typeof stored) {
      return fakeSupabase((request) =>
        request.path === "/rest/v1/api_keys" ? { body: request.params.get("prefix") === `eq.${prefix}` ? [row] : [] } : database()(request)
      );
    }

    it("answers 401 to an unknown key", async () => {
      const fake = withKey(stored);
      const response = await post(fake, INITIALIZE, `Bearer ${generateApiKey().token}`);
      expectRefused(response);
      expect(await response.json()).toEqual(UNAUTHORIZED);
      expect(tenantRequests(fake)).toEqual([]);
    });

    it("answers 401 to a revoked key", async () => {
      const fake = withKey({ ...stored, revoked_at: "2026-09-29T00:00:00Z" });
      const response = await post(fake, INITIALIZE, `Bearer ${token}`);
      expectRefused(response);
      expect(await response.json()).toEqual(UNAUTHORIZED);
      expect(tenantRequests(fake)).toEqual([]);
    });

    it("serves a live key, and every tool call runs in that key's workspace", async () => {
      const fake = withKey(stored);
      const response = await post(fake, legacyRequest({ id: 2, method: "tools/call", params: { name: "get_status", arguments: {} } }, "2025-06-18"), `Bearer ${token}`);
      expect(response.status).toBe(200);
      const result = (await reply(response)).result as unknown as CallResult;
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as { data: { businessName: string } }).data.businessName).toBe("Org B");
      for (const request of tenantRequests(fake)) expect(carriesOrg(request, ORG_B)).toBe(true);
    });
  });

  it("ignores a key in the query string, answers 401, and never echoes it", async () => {
    // The key is live: sent in the header, it would be admitted.
    vi.mocked(authenticateApiKey).mockImplementation(async (authorization) => (authorization === AUTHORIZATION ? KEY_A : null));
    const fake = fakeSupabase(database());
    const response = await send(POST, fake, { ...INITIALIZE, url: `/api/mcp?key=${PRESENTED}&api_key=${PRESENTED}&access_token=${PRESENTED}` });
    expectRefused(response);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual(UNAUTHORIZED);
    expect(text).not.toContain(PRESENTED);
    expect(vi.mocked(authenticateApiKey)).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("ignores a key in the MCP _meta, answers 401, and never echoes it", async () => {
    // The key is live: sent in the header, it would be admitted.
    vi.mocked(authenticateApiKey).mockImplementation(async (authorization) => (authorization === AUTHORIZATION ? KEY_A : null));
    const fake = fakeSupabase(database());
    const message = legacyRequest({ id: 1, method: "tools/list", params: { _meta: { authorization: AUTHORIZATION, apiKey: PRESENTED } } }, "2025-06-18");
    const response = await post(fake, message, null);
    expectRefused(response);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual(UNAUTHORIZED);
    expect(text).not.toContain(PRESENTED);
    expect(vi.mocked(authenticateApiKey)).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("answers 403 to a key without the read scope", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ ...KEY_A, scopes: [] });
    const fake = fakeSupabase(database());
    const response = await post(fake, INITIALIZE);
    expectRefused(response, 403);
    expect(response.headers.get("www-authenticate")).toBe(`${CHALLENGE}, error="insufficient_scope", scope="read"`);
    expect(await response.json()).toEqual({ error: { code: "forbidden", message: "This key cannot do that." } });
    expect(tenantRequests(fake)).toEqual([]);
  });

  it("answers 500, never 401, when the key cannot be checked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(authenticateApiKey).mockRejectedValue(new Error("connection to api_keys refused"));
    const fake = fakeSupabase(database());
    const response = await post(fake, INITIALIZE);
    expect(response.status).toBe(500);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await response.json()).toEqual({ error: { code: "internal", message: "The request could not be completed." } });
    expect(reached.count).toBe(0);
  });

  it.each([
    ["GET", GET],
    ["DELETE", DELETE],
  ] as const)("guards %s the same way", async (method, handler) => {
    const fake = fakeSupabase(database());
    const response = await send(handler, fake, { method });
    expectRefused(response);
    expect(await response.json()).toEqual(UNAUTHORIZED);
  });
});

describe("the MCP protocol, with a valid key", () => {
  beforeEach(() => {
    vi.mocked(authenticateApiKey).mockResolvedValue(KEY_A);
  });

  it.each([LATEST_PROTOCOL_VERSION, "2025-06-18"])("initializes a client asking for %s, as vestiarion", async (version) => {
    const fake = fakeSupabase(database());
    const response = await post(fake, legacyRequest({ id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "t", version: "1" } } }));
    expect(response.status).toBe(200);
    const message = await reply(response);
    expect(message.id).toBe(1);
    expect(message.result).toMatchObject({ protocolVersion: version, serverInfo: { name: "vestiarion", version: "1.0.0" } });
    // Tools only, and a static list (spec M5): no resources, no prompts, nothing to listen for.
    expect((message.result as { capabilities: unknown }).capabilities).toEqual({ tools: { listChanged: false } });
    expect(reached.count).toBe(1);
  });

  it(`answers server/discover from a ${MODERN} client, as vestiarion`, async () => {
    const fake = fakeSupabase(database());
    const response = await post(fake, modernRequest({ id: 1, method: "server/discover" }));
    expect(response.status).toBe(200);
    const result = (await reply(response)).result as { supportedVersions: string[]; capabilities: Record<string, unknown>; _meta: Record<string, unknown> };
    expect(result.supportedVersions).toContain(MODERN);
    // The tool list is fixed, so there is never a change to announce.
    expect(result.capabilities.tools).toEqual({ listChanged: false });
    expect(result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({ name: "vestiarion", version: "1.0.0" });
  });

  it(`closes a ${MODERN} subscriptions/listen stream at once, rather than holding the function open`, async () => {
    const fake = fakeSupabase(database());
    const response = await post(fake, modernRequest({ id: 11, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true } } }));
    expect(response.status).toBe(200);

    // Read the whole body, giving up after a second: a stream that stays open
    // would only ever send keep-alives until `maxDuration`.
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), 1000)));
    let ended = false;
    try {
      while (true) {
        const chunk = await Promise.race([reader.read(), timedOut]);
        if (chunk === "timeout") break;
        if (chunk.done) {
          ended = true;
          break;
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      clearTimeout(timer);
      if (!ended) await reader.cancel();
    }
    expect(ended).toBe(true);

    const messages = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
    // The acknowledgement honors nothing, and the listen request completes.
    expect(messages[0]).toMatchObject({ method: "notifications/subscriptions/acknowledged", params: { notifications: {} } });
    expect(messages.at(-1)).toMatchObject({ id: 11, result: { resultType: "complete" } });
    expect(fake.requests).toEqual([]);
  });

  it.each([
    ["GET", GET],
    ["DELETE", DELETE],
  ] as const)("answers %s with 405 past the key check, and reads nothing", async (method, handler) => {
    const fake = fakeSupabase(database());
    const response = await send(handler, fake, { method, authorization: AUTHORIZATION, headers: { "mcp-protocol-version": "2025-06-18" } });
    expect(response.status).toBe(405);
    expect(reached.count).toBe(1);
    expect(tenantRequests(fake)).toEqual([]);
  });

  describe.each(ERAS)("a %s client", (_version, request) => {
    it("lists the nine tools, every one read-only", async () => {
      const fake = fakeSupabase(database());
      const response = await post(fake, request(2, "tools/list"));
      expect(response.status).toBe(200);
      const tools = (await reply(response)).result?.tools as Array<{ name: string; title: string; inputSchema: { type: string }; annotations: Record<string, unknown> }>;
      expect(tools).toHaveLength(9);
      expect(tools.map((tool) => tool.name).sort()).toEqual(MCP_TOOLS.map((tool) => tool.name).sort());
      for (const tool of tools) {
        expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false, idempotentHint: true });
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.title).toBe(MCP_TOOLS.find((known) => known.name === tool.name)?.title);
      }
      // Listing reads nothing.
      expect(fake.requests).toEqual([]);
    });

    it("calls verify_ledger, with the caller's key, and gets the route's own JSON", async () => {
      const direct = fakeSupabase(database());
      const expected = await runWith({ config, db: direct.client, fetch: direct.fetch }, async () => {
        const response = await verifyLedgerRoute(new Request(`${ORIGIN}/api/v1/ledger/verify`, { headers: { authorization: AUTHORIZATION } }));
        return response.json();
      });
      vi.mocked(authenticateApiKey).mockClear();

      const fake = fakeSupabase(database());
      const response = await post(fake, request(3, "tools/call", { name: "verify_ledger", arguments: {} }));
      expect(response.status).toBe(200);
      const result = (await reply(response)).result as unknown as CallResult;
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(expected);
      expect(JSON.parse(result.content[0].text)).toEqual(expected);
      // Checked once by this route and once by the operation's own route, with the same header.
      expect(vi.mocked(authenticateApiKey).mock.calls).toEqual([[AUTHORIZATION], [AUTHORIZATION]]);
      const tenant = tenantRequests(fake);
      expect(tenant.length).toBeGreaterThan(0);
      for (const recorded of tenant) {
        expect(carriesOrg(recorded, ORG_A)).toBe(true);
        expect(carriesOrg(recorded, ORG_B)).toBe(false);
      }
    });

    it("answers an unknown tool in JSON-RPC, not with an HTTP error", async () => {
      const fake = fakeSupabase(database());
      const response = await post(fake, request(4, "tools/call", { name: "delete_everything", arguments: {} }));
      expect(response.status).toBe(200);
      const message = await reply(response);
      expect(message.id).toBe(4);
      const refused = message.error !== undefined || (message.result as unknown as CallResult | undefined)?.isError === true;
      expect(refused).toBe(true);
      expect(fake.requests).toEqual([]);
    });

    it.each([
      ["a limit of the wrong type", { limit: "abc" }],
      ["a status outside the enum", { status: "bogus" }],
    ])("refuses %s as a tool error, before any read", async (_label, args) => {
      const fake = fakeSupabase(database());
      const response = await post(fake, request(5, "tools/call", { name: "list_invoices", arguments: args }));
      expect(response.status).toBe(200);
      const message = await reply(response);
      expect(message.error).toBeUndefined();
      expect((message.result as unknown as CallResult).isError).toBe(true);
      expect(tenantRequests(fake)).toEqual([]);
    });

    it("answers get_counterparty for another workspace's id as not_found, asking only within the key's own", async () => {
      const id = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
      const fake = fakeSupabase(database());
      const response = await post(fake, request(6, "tools/call", { name: "get_counterparty", arguments: { id } }));
      const result = (await reply(response)).result as unknown as CallResult;
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ error: { code: "not_found", message: `Counterparty "${id}" was not found.` } });
      const lookups = tenantRequests(fake);
      expect(lookups.length).toBeGreaterThan(0);
      for (const recorded of lookups) expect(carriesOrg(recorded, ORG_A)).toBe(true);
    });

    it("returns a full page of 200 invoices without truncating it", async () => {
      const rows = Array.from({ length: 201 }, (_, index) => ({
        id: `9440f32c-000d-4a63-97f1-${String(index).padStart(12, "0")}`,
        direction: "payable",
        status: "held",
        amount: 1200 + index,
        currency: "USDC",
        memo: `Design work, part ${index}, with a long enough memo to make the page large`.repeat(4),
        po_reference: null,
        goods_received: true,
        due_date: "2026-10-01",
        decided_at: null,
        settled_at: null,
        escalated_at: null,
        agent_reasoning: "Over the counterparty's limit.",
        tx_ref: null,
        counterparties: null,
        created_at: `2026-09-28T00:00:${String(index % 60).padStart(2, "0")}Z`,
      }));
      const fake = fakeSupabase(database({ "/rest/v1/invoices": rows }));
      const response = await post(fake, request(7, "tools/call", { name: "list_invoices", arguments: { limit: 200 } }));
      const result = (await reply(response)).result as unknown as CallResult;
      expect(result.isError).toBeUndefined();
      const page = result.structuredContent as { data: unknown[]; page: { nextCursor: string | null } };
      expect(page.data).toHaveLength(200);
      expect(page.page.nextCursor).toEqual(expect.any(String));
      expect(result.content[0].text.length).toBeGreaterThan(100_000);
      expect(JSON.parse(result.content[0].text)).toEqual(page);
    });
  });

  it("never logs the key or an argument", async () => {
    const lines: unknown[][] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args));
    }
    const secretArgument = "argument-that-must-not-be-logged";
    const fake = fakeSupabase(database());
    for (const [, request] of ERAS) {
      await (await post(fake, request(8, "tools/call", { name: "list_invoices", arguments: { cursor: secretArgument } }))).text();
      await (await post(fake, request(9, "tools/call", { name: "list_invoices", arguments: { limit: secretArgument } }))).text();
      await (await post(fake, request(10, "tools/call", { name: secretArgument, arguments: {} }))).text();
    }
    const logged = lines.map((args) => args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(" ")).join("\n");
    expect(logged).not.toContain(PRESENTED);
    expect(logged).not.toContain(secretArgument);
  });
});
