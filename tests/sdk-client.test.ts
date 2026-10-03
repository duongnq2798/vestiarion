import { afterEach, describe, expect, it, vi } from "vitest";
import { OPERATIONS } from "@/lib/api/openapi";
import { Vestiarion, VestiarionError, type FetchLike } from "../sdk/src/index";

/** The client's methods, one per API operation (TypeScript SDK design R4). */

const KEY = `vxk_abcdefgh_${"A".repeat(43)}`;
type Call = { url: URL; method: string; headers: Record<string, string>; body?: string };

function client(answer: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url: new URL(url), method: init.method, headers: { ...init.headers }, body: init.body };
    calls.push(call);
    const { status, body } = answer(call);
    return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  return { calls, sdk: new Vestiarion({ apiKey: KEY, baseUrl: "https://api.test", fetch, maxRetries: 0 }) };
}

const page = (nextCursor: string | null, count: number) => ({ nextCursor, hasMore: nextCursor !== null, count });
const anything = (call: Call) => ({ status: call.method === "POST" ? 201 : 200, body: { data: call.url.pathname.endsWith("s") ? [] : {}, page: page(null, 0) } });

const INVOICE = { counterpartyId: "6b361405-cfda-4400-a286-364b561911ce", amount: "0.10", dueDate: "2026-10-03" };
const COUNTERPARTY = { name: "API Test Vendor", role: "vendor" as const };
const MILESTONE = { contractorId: "cp_1", title: "TypeScript SDK for the API", amount: "0.10", verificationSource: "https://github.com/acme/widgets/pull/42" };

/** How each operation is called through the SDK. */
const CALLS: Record<string, (sdk: Vestiarion) => Promise<unknown>> = {
  "get-status": (sdk) => sdk.status.get(),
  "list-ledger-entries": (sdk) => sdk.ledger.list(),
  "verify-ledger": (sdk) => sdk.ledger.verify(),
  "list-invoices": (sdk) => sdk.invoices.list(),
  "create-invoice": (sdk) => sdk.invoices.create(INVOICE),
  "list-counterparties": (sdk) => sdk.counterparties.list(),
  "get-counterparty": (sdk) => sdk.counterparties.get("cp_1"),
  "create-counterparty": (sdk) => sdk.counterparties.create(COUNTERPARTY),
  "create-payee-link": (sdk) => sdk.payeeLinks.create({ counterpartyId: "cp_1" }),
  "list-milestones": (sdk) => sdk.milestones.list(),
  "create-milestone": (sdk) => sdk.milestones.create(MILESTONE),
  "get-treasury": (sdk) => sdk.treasury.get(),
  "get-insights": (sdk) => sdk.insights.get(),
};

afterEach(() => vi.unstubAllGlobals());

describe("new Vestiarion", () => {
  it("refuses a key that is not a workspace API key, without repeating it (Review focus 3)", () => {
    const attempt = () => new Vestiarion({ apiKey: "sk_live_not_ours_123" });
    expect(attempt).toThrow(TypeError);
    expect(attempt).toThrow(/vxk_<prefix>_<secret>/);
    expect(attempt).not.toThrow(/sk_live_not_ours_123/);
  });

  it.each([
    ["a base URL over plain HTTP", { baseUrl: "http://www.vestiarion.xyz" }, /baseUrl/],
    ["a base URL that is not a URL", { baseUrl: "vestiarion" }, /baseUrl/],
    ["maxRetries that is not a whole number", { maxRetries: Number.NaN }, /maxRetries/],
    ["negative maxRetries", { maxRetries: -1 }, /maxRetries/],
    ["a timeout that is not a positive number", { timeoutMs: 0 }, /timeoutMs/],
  ])("refuses %s, rather than send the key in the clear or retry forever", (_label, options, message) => {
    expect(() => new Vestiarion({ apiKey: KEY, ...options })).toThrow(message);
  });

  it("allows plain HTTP to a server on this machine, for local testing", () => {
    for (const baseUrl of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(() => new Vestiarion({ apiKey: KEY, baseUrl })).not.toThrow();
    }
  });

  it("uses the runtime's fetch by default, called as a function, on www.vestiarion.xyz", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", function (this: unknown, url: string) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      seen.push(url);
      return Promise.resolve(new Response(JSON.stringify({ data: {} })));
    });
    await new Vestiarion({ apiKey: KEY }).status.get();
    expect(seen).toEqual(["https://www.vestiarion.xyz/api/v1/status"]);
  });
});

describe("the client's methods", () => {
  it("cover every API operation, each sending the operation's method and path", async () => {
    expect(Object.keys(CALLS).sort()).toEqual(OPERATIONS.map((op) => op.id).sort());
    for (const op of OPERATIONS) {
      const { calls, sdk } = client(anything);
      await CALLS[op.id](sdk);
      expect(calls, op.id).toHaveLength(1);
      expect(calls[0].method, op.id).toBe(op.method.toUpperCase());
      expect(calls[0].url.pathname, op.id).toBe(op.path.replace("{id}", "cp_1"));
    }
  });

  it("return a resource's data, and a list's data and page", async () => {
    const { sdk } = client(() => ({ status: 200, body: { data: { apiVersion: "v1" } } }));
    expect(await sdk.status.get()).toEqual({ apiVersion: "v1" });
    const lists = client(() => ({ status: 200, body: { data: [{ id: "i1" }], page: page(null, 1) } }));
    expect(await lists.sdk.invoices.list({ status: "held" })).toEqual({ data: [{ id: "i1" }], page: page(null, 1) });
    expect(lists.calls[0].url.search).toBe("?status=held");
  });

  it("encode a counterparty's id in its path", async () => {
    const { calls, sdk } = client(() => ({ status: 200, body: { data: {} } }));
    await sdk.counterparties.get("a/b?c");
    expect(calls[0].url.pathname).toBe("/api/v1/counterparties/a%2Fb%3Fc");
  });

  it("send a write's input as its body, with the caller's idempotencyKey", async () => {
    const { calls, sdk } = client(() => ({ status: 201, body: { data: { id: "i1" } } }));
    expect(await sdk.invoices.create(INVOICE, { idempotencyKey: "billing-inv-1" })).toEqual({ id: "i1" });
    expect(JSON.parse(calls[0].body!)).toEqual(INVOICE);
    expect(calls[0].headers["idempotency-key"]).toBe("billing-inv-1");
    expect(await sdk.milestones.create(MILESTONE, { idempotencyKey: "ci-bounty-pr-42" })).toEqual({ id: "i1" });
    expect(JSON.parse(calls[1].body!)).toEqual(MILESTONE);
    expect(calls[1].headers["idempotency-key"]).toBe("ci-bounty-pr-42");
  });

  it("make a payee link with no Idempotency-Key, which the API keeps no outcome for, and return its address (write API part 2, W3)", async () => {
    const link = { id: "l1", counterpartyId: "cp_1", url: "https://www.vestiarion.xyz/payee/vxp_x", expiresAt: "2026-10-10T15:00:00Z" };
    const { calls, sdk } = client(() => ({ status: 201, body: { data: link } }));
    expect(await sdk.payeeLinks.create({ counterpartyId: "cp_1" })).toEqual(link);
    expect(JSON.parse(calls[0].body!)).toEqual({ counterpartyId: "cp_1" });
    expect(calls[0].headers).not.toHaveProperty("idempotency-key");
    expect(calls[0].headers["content-type"]).toBe("application/json");
  });
});

describe("pagination", () => {
  const twoPages = (call: Call) =>
    call.url.searchParams.get("cursor") === "c1"
      ? { status: 200, body: { data: [{ id: "c" }], page: page(null, 1) } }
      : { status: 200, body: { data: [{ id: "a" }, { id: "b" }], page: page("c1", 2) } };

  it("listAll yields every item, passing each nextCursor back with the same filters", async () => {
    const { calls, sdk } = client(twoPages);
    const ids: string[] = [];
    for await (const invoice of sdk.invoices.listAll({ status: "held" })) ids.push(invoice.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(calls.map((call) => call.url.search)).toEqual(["?status=held", "?status=held&cursor=c1"]);
  });

  it("pages starts at the cursor given, so a ledger mirror resumes from what it stored", async () => {
    const { calls, sdk } = client(twoPages);
    const cursors: Array<string | null> = [];
    for await (const answer of sdk.ledger.pages({ cursor: "c1" })) cursors.push(answer.page.nextCursor);
    expect(cursors).toEqual([null]);
    expect(calls.map((call) => call.url.searchParams.get("cursor"))).toEqual(["c1"]);
  });

  it("ends at a page that says there is more but gives no cursor, and refuses the same cursor twice (Review focus 1)", async () => {
    const noCursor = client(() => ({ status: 200, body: { data: [{ id: "a" }], page: { nextCursor: null, hasMore: true, count: 1 } } }));
    const ids: string[] = [];
    for await (const invoice of noCursor.sdk.invoices.listAll()) ids.push(invoice.id);
    expect(ids).toEqual(["a"]);

    const stuck = client(() => ({ status: 200, body: { data: [], page: page("same", 0) } }));
    const pages = stuck.sdk.invoices.pages({ cursor: "same" });
    await expect((async () => { for await (const _ of pages) void _; })()).rejects.toMatchObject({ code: "invalid_response" });
    expect(stuck.calls).toHaveLength(1);
  });

  it("throws a failed page as a VestiarionError", async () => {
    const { sdk } = client(() => ({ status: 400, body: { error: { code: "invalid_request", message: "cursor is not valid for this endpoint." } } }));
    await expect(sdk.invoices.list({ cursor: "x" })).rejects.toBeInstanceOf(VestiarionError);
  });
});
