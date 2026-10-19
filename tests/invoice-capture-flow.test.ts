import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as tokenPOST } from "@/app/api/extension/v1/token/route";
import { POST as revokePOST } from "@/app/api/extension/v1/revoke/route";
import { GET as sessionGET, OPTIONS as sessionOPTIONS } from "@/app/api/extension/v1/session/route";
import { OPTIONS as draftsOPTIONS, POST as draftsPOST } from "@/app/api/extension/v1/invoice-drafts/route";
import { GET as draftGET, PATCH as draftPATCH } from "@/app/api/extension/v1/invoice-drafts/[id]/route";
import { POST as sendPOST } from "@/app/api/extension/v1/invoice-drafts/[id]/send/route";
import { GET as invoicesGET } from "@/app/api/v1/invoices/route";
import { POST as mcpPOST } from "@/app/api/mcp/route";
import { consoleActor, memberActor } from "@/lib/commands/actor";
import { confirmInvoiceDraft, discardInvoiceDraft } from "@/lib/commands/invoice-drafts";
import { addInvoice } from "@/lib/commands/invoices";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { challengeOf } from "@/lib/extension/pkce";
import { issueAuthorizationCode, revokeConnection } from "@/lib/extension/tokens";
import { invoiceInputSchema } from "@/lib/intake-validation";
import { removeMember } from "@/lib/platform/members";
import type { RecordedRequest } from "./support/fake-supabase";
import { memoryPostgrest, withId, type Row } from "./support/memory-postgrest";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * Invoice capture end to end, in-process (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C1-C22): the
 * consent's code exchanged with PKCE, each refusal of the exchange, the token reaching the draft endpoints and nothing
 * else, a capture read into a draft, idempotent, within its caps, edited and sent, CORS, revocation, and a draft
 * becoming a bill only through the console's step, which runs the add-invoice command.
 */

vi.mock("server-only", () => ({}));
const { cycleMock } = vi.hoisted(() => ({ cycleMock: vi.fn() }));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: cycleMock, raiseCycleEvent: vi.fn() }));
vi.mock("@/lib/commands/invoices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/commands/invoices")>();
  return { ...actual, addInvoice: vi.fn(actual.addInvoice) };
});

const CLIENT = "abcdefghijklmnopabcdefghijklmnop";
const OTHER_CLIENT = "ponmlkjihgfedcbaponmlkjihgfedcba";
const ORIGIN = `chrome-extension://${CLIENT}`;
const REDIRECT = `https://${CLIENT}.chromiumapp.org/`;
const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const APPROVER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e2";
const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const BASE = "https://www.vestiarion.xyz";
const INVOICE_TEXT = [
  "Northwind Hosting",
  "Invoice number: INV-2207",
  "Invoice date: 2026-10-01",
  "Due date: 2026-10-31",
  "Purchase order: PO-1042",
  "Total due: 200.00 USDC",
].join("\n");

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const savedIds = process.env.CHROME_EXTENSION_IDS;

beforeEach(() => {
  process.env.CHROME_EXTENSION_IDS = `${CLIENT}, ${OTHER_CLIENT}`;
  cycleMock.mockReset();
  vi.mocked(addInvoice).mockClear();
});
afterEach(() => {
  if (savedIds === undefined) delete process.env.CHROME_EXTENSION_IDS;
  else process.env.CHROME_EXTENSION_IDS = savedIds;
});

const now = () => new Date().toISOString();

/** One workspace, its owner and an approver, a vendor, and an empty book: a fresh id each, so no limit carries over. */
function world(options: { before?: (request: RecordedRequest) => Promise<void> | void; failLedger?: (action: string) => boolean } = {}) {
  const orgId = crypto.randomUUID();
  const ledger: Row[] = [];
  const db = memoryPostgrest({
    before: options.before,
    seed: {
      orgs: [orgs.orgRow(orgId)],
      memberships: [
        { org_id: orgId, user_id: OWNER, role: "owner" },
        { org_id: orgId, user_id: APPROVER, role: "approver" },
      ],
      counterparties: [{ id: COUNTERPARTY, org_id: orgId, name: "Northwind Hosting", role: "vendor", address: null }],
    },
    specs: {
      invoice_drafts: {
        defaults: () => ({ id: crypto.randomUUID(), state: "draft", captured_at: now(), updated_at: now(), sent_at: null, decided_by: null, decided_at: null, invoice_id: null }),
        unique: [["org_id", "connection_id", "idempotency_key"]],
      },
      extension_grants: {
        defaults: withId(() => ({ revoked_at: null, revoked_by: null, revoked_reason: null, refreshed_at: null, retired_refresh_hash: null })),
        unique: [["access_token_hash"], ["refresh_token_hash"], ["code_hash"]],
      },
      extension_auth_codes: { defaults: () => ({ created_at: now(), used_at: null }), unique: [["code_hash"]] },
      invoices: { defaults: withId(() => ({ status: "pending" })) },
    },
    rpc: {
      append_ledger_entry: (args) => {
        if (options.failLedger?.(String(args.p_action))) {
          return { status: 500, body: { code: "XX000", message: "the ledger could not be written", details: null, hint: null } };
        }
        ledger.push(args);
        return { body: { ...APPENDED_LEDGER_ROW, action: args.p_action } };
      },
      // Ending a membership, as migration 0069 does it; 0121's foreign key takes the person's connections with it.
      remove_member_revoking_keys: (args) => {
        const gone = (row: Row) => row.org_id === args.p_org_id && row.user_id === args.p_user_id;
        const role = db.rows("memberships").find(gone)?.role;
        db.tables.memberships = db.rows("memberships").filter((row) => !gone(row));
        db.tables.extension_grants = db.rows("extension_grants").filter((row) => !gone(row));
        return { body: { removed_role: role, revoked_key_ids: [] } };
      },
    },
  });
  const run = <T>(fn: () => Promise<T>) => runWith({ config, db: db.client, fetch: db.fetch }, fn);
  const actions = () => ledger.map((entry) => entry.p_action);
  return { orgId, db, ledger, run, actions };
}
type World = ReturnType<typeof world>;

const address = () => `198.51.100.${crypto.randomInt(1, 254)}`;

function form(url: string, params: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "x-forwarded-for": address(), ...headers },
    body: new URLSearchParams(params).toString(),
  });
}

/** A person's consent: the code for a verifier, issued as the authorize page's Allow issues it. */
async function consent(w: World, options: { now?: Date; userId?: string; scopes?: Array<"invoice_draft:create" | "invoice_draft:read"> } = {}) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const code = await w.run(() =>
    issueAuthorizationCode({
      orgId: w.orgId,
      userId: options.userId ?? OWNER,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeChallenge: challengeOf(verifier),
      scopes: options.scopes ?? ["invoice_draft:create", "invoice_draft:read"],
      now: options.now,
    })
  );
  return { code, verifier };
}

function exchange(w: World, params: Record<string, string>, headers: Record<string, string> = {}) {
  return w.run(() => tokenPOST(form(`${BASE}/api/extension/v1/token`, { grant_type: "authorization_code", client_id: CLIENT, redirect_uri: REDIRECT, ...params }, headers)));
}

async function connect(w: World, options: { scopes?: Array<"invoice_draft:create" | "invoice_draft:read"> } = {}) {
  const { code, verifier } = await consent(w, options);
  const response = await exchange(w, { code, code_verifier: verifier });
  expect(response.status).toBe(200);
  return (await response.json()) as { access_token: string; refresh_token: string; scope: string; audience: string; expires_in: number; workspace: { name: string; slug: string } };
}

function call(token: string | null, url: string, init: RequestInit = {}, origin: string | null = ORIGIN): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (origin) headers.set("origin", origin);
  return new Request(url, { ...init, headers });
}

function capture(w: World, token: string, body: unknown, key: string | null = crypto.randomUUID(), origin: string | null = ORIGIN) {
  return w.run(() =>
    draftsPOST(
      call(token, `${BASE}/api/extension/v1/invoice-drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }, origin)
    )
  );
}

/** A file sent as the extension's fetch sends it: a multipart form with its Content-Length. */
async function upload(w: World, token: string, file: File, options: { declareLength?: boolean } = {}) {
  const form = new FormData();
  form.append("file", file);
  const encoded = new Request(`${BASE}/api/extension/v1/invoice-drafts`, { method: "POST", body: form });
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  const headers: Record<string, string> = { "idempotency-key": crypto.randomUUID(), "content-type": encoded.headers.get("content-type") ?? "" };
  if (options.declareLength !== false) headers["content-length"] = String(bytes.length);
  return w.run(() => draftsPOST(call(token, `${BASE}/api/extension/v1/invoice-drafts`, { method: "POST", headers, body: bytes })));
}

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

function patch(w: World, token: string, id: string, fields: unknown) {
  return w.run(() =>
    draftPATCH(call(token, `${BASE}/api/extension/v1/invoice-drafts/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(fields) }), idParams(id))
  );
}

function send(w: World, token: string, id: string) {
  return w.run(() => sendPOST(call(token, `${BASE}/api/extension/v1/invoice-drafts/${id}/send`, { method: "POST" }), idParams(id)));
}

function read(w: World, token: string, id: string) {
  return w.run(() => draftGET(call(token, `${BASE}/api/extension/v1/invoice-drafts/${id}`), idParams(id)));
}

describe("the code exchange (C14, C15)", () => {
  it("gives a token pair for the drafts' audience and scopes only, and records the connection", async () => {
    const w = world();
    const tokens = await connect(w);
    expect(tokens.access_token).toMatch(/^vxa_[A-Za-z0-9_-]{43}$/);
    expect(tokens.refresh_token).toMatch(/^vxr_[A-Za-z0-9_-]{43}$/);
    expect(tokens).toMatchObject({ audience: "vestiarion-chrome", scope: "invoice_draft:create invoice_draft:read", expires_in: 3600, workspace: { slug: "northstar" } });
    // Only the hashes are kept.
    const [grant] = w.db.rows("extension_grants");
    expect(JSON.stringify(grant)).not.toContain(tokens.access_token);
    expect(grant.access_token_hash).toBe(crypto.createHash("sha256").update(tokens.access_token).digest("hex"));
    expect(w.actions()).toContain("extension_connected");
  });

  it("refuses a wrong verifier, and the code is spent by the attempt", async () => {
    const w = world();
    const { code, verifier } = await consent(w);
    const wrong = await exchange(w, { code, code_verifier: crypto.randomBytes(32).toString("base64url") });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
    const right = await exchange(w, { code, code_verifier: verifier });
    expect(right.status).toBe(400);
    expect(w.db.rows("extension_grants")).toHaveLength(0);
  });

  it("refuses a code used twice, and ends the connection the first use made", async () => {
    const w = world();
    const { code, verifier } = await consent(w);
    const first = await exchange(w, { code, code_verifier: verifier });
    expect(first.status).toBe(200);
    const { access_token: accessToken } = await first.json();
    const again = await exchange(w, { code, code_verifier: verifier });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "invalid_grant" });
    expect(w.db.rows("extension_grants")[0]).toMatchObject({ revoked_reason: "reused_code" });
    const refused = await w.run(() => sessionGET(call(accessToken, `${BASE}/api/extension/v1/session`)));
    expect(refused.status).toBe(401);
  });

  it("refuses an expired code", async () => {
    const w = world();
    const { code, verifier } = await consent(w, { now: new Date(Date.now() - 6 * 60_000) });
    const response = await exchange(w, { code, code_verifier: verifier });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses a redirect address or a client the code was not issued to", async () => {
    const w = world();
    const { code, verifier } = await consent(w);
    const wrongRedirect = await exchange(w, { code, code_verifier: verifier, redirect_uri: `https://${CLIENT}.chromiumapp.org/elsewhere` });
    expect(wrongRedirect.status).toBe(400);
    expect(await wrongRedirect.json()).toMatchObject({ error: "invalid_grant" });

    const second = await consent(w);
    const otherClient = await exchange(w, { code: second.code, code_verifier: second.verifier, client_id: OTHER_CLIENT, redirect_uri: `https://${OTHER_CLIENT}.chromiumapp.org/` }, { origin: `chrome-extension://${OTHER_CLIENT}` });
    expect(otherClient.status).toBe(400);
    const unknownClient = await exchange(w, { code: second.code, code_verifier: second.verifier, client_id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" });
    expect(unknownClient.status).toBe(401);
    expect(await unknownClient.json()).toMatchObject({ error: "invalid_client" });
  });

  it("refuses another audience or any scope beyond the drafts', before the code is spent", async () => {
    const w = world();
    const { code, verifier } = await consent(w);
    const audience = await exchange(w, { code, code_verifier: verifier, resource: "https://www.vestiarion.xyz/api/v1" });
    expect(audience.status).toBe(400);
    expect(await audience.json()).toMatchObject({ error: "invalid_target" });
    const scope = await exchange(w, { code, code_verifier: verifier, scope: "invoice_draft:create invoices:write" });
    expect(scope.status).toBe(400);
    expect(await scope.json()).toMatchObject({ error: "invalid_scope" });
    const grant = await exchange(w, { grant_type: "client_credentials", code, code_verifier: verifier });
    expect(grant.status).toBe(400);
    expect(await grant.json()).toMatchObject({ error: "unsupported_grant_type" });
    // None of those reached the code: it still works.
    expect((await exchange(w, { code, code_verifier: verifier })).status).toBe(200);
  });

  it("refuses a person who can no longer add bills", async () => {
    const w = world();
    const { code, verifier } = await consent(w, { userId: APPROVER });
    const response = await exchange(w, { code, code_verifier: verifier });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("replaces the pair on refresh: the old access token stops, and the new pair works", async () => {
    const w = world();
    const tokens = await connect(w);
    const refresh = (token: string) => w.run(() => tokenPOST(form(`${BASE}/api/extension/v1/token`, { grant_type: "refresh_token", refresh_token: token, client_id: CLIENT })));
    const first = await refresh(tokens.refresh_token);
    expect(first.status).toBe(200);
    const renewed = await first.json();
    expect(renewed.refresh_token).not.toBe(tokens.refresh_token);
    expect((await w.run(() => sessionGET(call(tokens.access_token, `${BASE}/api/extension/v1/session`)))).status).toBe(401);
    expect((await w.run(() => sessionGET(call(renewed.access_token, `${BASE}/api/extension/v1/session`)))).status).toBe(200);
    expect((await refresh(renewed.refresh_token)).status).toBe(200);
  });

  it("ends the connection when a refresh token it replaced is used again", async () => {
    const w = world();
    const tokens = await connect(w);
    const refresh = (token: string) => w.run(() => tokenPOST(form(`${BASE}/api/extension/v1/token`, { grant_type: "refresh_token", refresh_token: token, client_id: CLIENT })));
    const renewed = await (await refresh(tokens.refresh_token)).json();
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
    expect(w.db.rows("extension_grants")[0]).toMatchObject({ revoked_reason: "reused_refresh" });
    expect((await w.run(() => sessionGET(call(renewed.access_token, `${BASE}/api/extension/v1/session`)))).status).toBe(401);
    expect((await refresh(renewed.refresh_token)).status).toBe(400);
  });

  it("keeps the old refresh token working when the workspace cannot be read, so a failed refresh never ends the connection", async () => {
    let failOrgs = false;
    let failedReads = 0;
    let saved: Row[] = [];
    const w: ReturnType<typeof world> = world({
      before: (request) => {
        // The workspace's name and slug, which the token answer carries: the read finds nothing, so it fails.
        if (failOrgs && request.method === "GET" && request.path === "/rest/v1/orgs" && request.params.get("select") === "name,slug") {
          failedReads += 1;
          saved = w.db.rows("orgs");
          w.db.tables.orgs = [];
        }
      },
    });
    const tokens = await connect(w);
    const refresh = () => w.run(() => tokenPOST(form(`${BASE}/api/extension/v1/token`, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: CLIENT })));
    failOrgs = true;
    const failed = await refresh();
    failOrgs = false;
    w.db.tables.orgs = saved;
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(failedReads).toBe(1);
    // Nothing was rotated: the extension still holds a working refresh token, and the retry gets a new pair.
    expect(w.db.rows("extension_grants")[0]).toMatchObject({ revoked_at: null, retired_refresh_hash: null });
    const retried = await refresh();
    expect(retried.status).toBe(200);
    expect(w.db.rows("extension_grants")[0]).toMatchObject({ revoked_at: null });
  });

  it("ends the connection when two refreshes with one token race: the extension never races itself", async () => {
    const w = world();
    const tokens = await connect(w);
    const refresh = () => w.run(() => tokenPOST(form(`${BASE}/api/extension/v1/token`, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: CLIENT })));
    const statuses = (await Promise.all([refresh(), refresh()])).map((response) => response.status).sort();
    expect(statuses).toEqual([200, 400]);
    expect(w.db.rows("extension_grants")[0]).toMatchObject({ revoked_reason: "reused_refresh" });
    expect(w.ledger.find((entry) => entry.p_action === "extension_disconnected")?.p_detail).toMatchObject({ reason: "reused_refresh" });
  });

  it("ends a connection whose code was presented again while it was being made", async () => {
    let replay: (() => Promise<Response>) | null = null;
    const w = world({
      before: async (request) => {
        // The moment the first exchange writes its connection, the same code arrives again.
        if (request.path === "/rest/v1/extension_grants" && request.method === "POST" && replay) {
          const again = replay;
          replay = null;
          expect((await again()).status).toBe(400);
        }
      },
    });
    const { code, verifier } = await consent(w);
    replay = () => exchange(w, { code, code_verifier: verifier });
    const first = await exchange(w, { code, code_verifier: verifier });
    expect(first.status).toBe(400);
    expect(w.db.rows("extension_auth_codes")[0].replayed_at).toBeTruthy();
    expect(w.db.rows("extension_grants")).toHaveLength(1);
    expect(w.db.rows("extension_grants")[0]).toMatchObject({ revoked_reason: "reused_code" });
  });

  it("leaves no connection standing when one code is exchanged twice at once", async () => {
    const w = world();
    const { code, verifier } = await consent(w);
    await Promise.all([exchange(w, { code, code_verifier: verifier }), exchange(w, { code, code_verifier: verifier })]);
    expect(w.db.rows("extension_grants").filter((grant) => grant.revoked_at === null)).toEqual([]);
  });

  it("ends the connection when the person can no longer add bills, at a refresh", async () => {
    const w = world();
    const tokens = await connect(w);
    w.db.rows("memberships")[0].role = "approver";
    const response = await w.run(() => tokenPOST(form(`${BASE}/api/extension/v1/token`, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: CLIENT })));
    expect(response.status).toBe(400);
    expect(w.db.rows("extension_grants")[0]).toMatchObject({ revoked_reason: "role_changed" });
    w.db.rows("memberships")[0].role = "owner";
    expect((await w.run(() => sessionGET(call(tokens.access_token, `${BASE}/api/extension/v1/session`)))).status).toBe(401);
  });

  it("never refreshes a connection past 90 days from its making", async () => {
    const w = world();
    const tokens = await connect(w);
    const [grant] = w.db.rows("extension_grants");
    const made = Date.now() - 89.5 * 86_400_000;
    grant.created_at = new Date(made).toISOString();
    const response = await w.run(() => tokenPOST(form(`${BASE}/api/extension/v1/token`, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: CLIENT })));
    expect(response.status).toBe(200);
    const end = made + 90 * 86_400_000;
    expect(Date.parse(String(grant.refresh_expires_at))).toBeLessThanOrEqual(end);
    expect(Date.parse(String(grant.access_expires_at))).toBeLessThanOrEqual(end);

    grant.created_at = new Date(Date.now() - 91 * 86_400_000).toISOString();
    grant.refresh_expires_at = new Date(Date.now() + 86_400_000).toISOString();
    const renewed = await response.json();
    const late = await w.run(() => tokenPOST(form(`${BASE}/api/extension/v1/token`, { grant_type: "refresh_token", refresh_token: renewed.refresh_token, client_id: CLIENT })));
    expect(late.status).toBe(400);
  });

  it("refuses a browser origin that is not an allowed extension", async () => {
    const w = world();
    const { code, verifier } = await consent(w);
    const response = await exchange(w, { code, code_verifier: verifier }, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("what the token reaches (C16)", () => {
  it("opens the draft endpoints, and nothing of /api/v1 or the MCP server", async () => {
    const w = world();
    const { access_token: token } = await connect(w);
    const session = await w.run(() => sessionGET(call(token, `${BASE}/api/extension/v1/session`)));
    expect(session.status).toBe(200);
    expect((await session.json()).data).toMatchObject({ workspace: { name: "Northstar", slug: "northstar" }, audience: "vestiarion-chrome" });

    const before = w.db.requests.length;
    const v1 = await w.run(() => invoicesGET(call(token, `${BASE}/api/v1/invoices`, {}, null)));
    expect(v1.status).toBe(401);
    const mcp = await w.run(() =>
      mcpPOST(call(token, `${BASE}/api/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }, null))
    );
    expect(mcp.status).toBe(401);
    // An extension token is not an API key: neither route even looked it up.
    expect(w.db.requests.slice(before).filter((request) => request.path === "/rest/v1/api_keys")).toHaveLength(0);
  });

  it("refuses an API key on the draft endpoints", async () => {
    const w = world();
    const response = await w.run(() => sessionGET(call(`vxk_abcdefgh_${"a".repeat(43)}`, `${BASE}/api/extension/v1/session`)));
    expect(response.status).toBe(401);
  });

  it("refuses a token without the route's scope", async () => {
    const w = world();
    const { access_token: token } = await connect(w, { scopes: ["invoice_draft:read"] });
    const response = await capture(w, token, { source: "selection", text: INVOICE_TEXT });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain("insufficient_scope");
  });

  it("refuses a person whose role no longer adds bills, read at every request, and ends the connection", async () => {
    const w = world();
    const { access_token: token } = await connect(w);
    w.db.rows("memberships")[0].role = "approver";
    const response = await capture(w, token, { source: "selection", text: INVOICE_TEXT });
    expect(response.status).toBe(403);
    expect(w.db.rows("invoice_drafts")).toHaveLength(0);
    expect(w.db.rows("extension_grants")[0]).toMatchObject({ revoked_reason: "role_changed" });
    // Made an admin again, the person connects again: the old connection stays ended.
    w.db.rows("memberships")[0].role = "admin";
    expect((await capture(w, token, { source: "selection", text: INVOICE_TEXT })).status).toBe(401);
  });

  it("answers 503 everywhere while no extension is allowed", async () => {
    const w = world();
    const { access_token: token } = await connect(w);
    delete process.env.CHROME_EXTENSION_IDS;
    expect((await w.run(() => sessionGET(call(token, `${BASE}/api/extension/v1/session`)))).status).toBe(503);
    expect((await exchange(w, { code: "vxc_x", code_verifier: "x" })).status).toBe(503);
  });
});

describe("CORS (C21)", () => {
  it("answers an allowed extension's preflight, and refuses any other origin's", async () => {
    const allowed = draftsOPTIONS(new Request(`${BASE}/api/extension/v1/invoice-drafts`, { method: "OPTIONS", headers: { origin: ORIGIN } }));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(allowed.headers.get("access-control-allow-headers")).toContain("Idempotency-Key");
    expect(allowed.headers.get("vary")).toBe("Origin");

    for (const origin of ["https://www.vestiarion.xyz", "https://evil.example", "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"]) {
      const refused = sessionOPTIONS(new Request(`${BASE}/api/extension/v1/session`, { method: "OPTIONS", headers: { origin } }));
      expect(refused.status, origin).toBe(403);
      expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("refuses a request from another origin even with a valid token, and names the extension's origin on its own", async () => {
    const w = world();
    const { access_token: token } = await connect(w);
    const refused = await capture(w, token, { source: "selection", text: INVOICE_TEXT }, crypto.randomUUID(), "https://evil.example");
    expect(refused.status).toBe(403);
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    const served = await capture(w, token, { source: "selection", text: INVOICE_TEXT });
    expect(served.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(served.headers.get("cache-control")).toBe("no-store");
  });
});

describe("a capture (C2-C4, C19, C20)", () => {
  it("reads selected text into a draft the extension sees without the workspace's records", async () => {
    const w = world();
    const { access_token: token } = await connect(w);
    const response = await capture(w, token, { source: "selection", text: INVOICE_TEXT });
    expect(response.status).toBe(201);
    const { data } = await response.json();
    expect(data).toMatchObject({
      state: "draft",
      source: "selection",
      fields: { supplierName: "Northwind Hosting", invoiceNumber: "INV-2207", amount: "200.00", currency: "USDC", invoiceDate: "2026-10-01", dueDate: "2026-10-31", poReference: "PO-1042" },
      missing: [],
      reviewUrl: null,
    });
    // The counterparty it matched stays in the console.
    expect(JSON.stringify(data)).not.toContain(COUNTERPARTY);
    const [row] = w.db.rows("invoice_drafts");
    expect(row).toMatchObject({ counterparty_id: COUNTERPARTY, captured_by: OWNER, raw_text: INVOICE_TEXT });
    // A draft is no invoice, and the agent was not asked to decide anything.
    expect(w.db.rows("invoices")).toHaveLength(0);
    expect(cycleMock).not.toHaveBeenCalled();
  });

  it("answers a double click with the same draft, and another capture under that key with 409", async () => {
    const w = world();
    const { access_token: token } = await connect(w);
    const key = crypto.randomUUID();
    const first = await capture(w, token, { source: "selection", text: INVOICE_TEXT }, key);
    const second = await capture(w, token, { source: "selection", text: INVOICE_TEXT }, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect((await second.json()).data.id).toBe((await first.json()).data.id);
    expect(w.db.rows("invoice_drafts")).toHaveLength(1);
    const conflict = await capture(w, token, { source: "selection", text: `${INVOICE_TEXT}\nAgain` }, key);
    expect(conflict.status).toBe(409);
    expect((await capture(w, token, { source: "selection", text: INVOICE_TEXT }, null)).status).toBe(400);
  });

  it("refuses too much text, too large a body or file, and an unknown field, before anything is read", async () => {
    const w = world();
    const { access_token: token } = await connect(w);
    expect((await capture(w, token, { source: "selection", text: "a".repeat(20_001) })).status).toBe(413);
    expect((await capture(w, token, JSON.stringify({ source: "selection", text: "é".repeat(60_000) }))).status).toBe(413);
    expect((await capture(w, token, { source: "selection", text: INVOICE_TEXT, url: "https://vendor.example" })).status).toBe(400);
    expect((await upload(w, token, new File([new Uint8Array(4_000_001)], "big.pdf", { type: "application/pdf" }))).status).toBe(413);
    // A file whose length is not declared is never read to find it out.
    expect((await upload(w, token, new File([new Uint8Array(10)], "small.pdf", { type: "application/pdf" }), { declareLength: false })).status).toBe(411);
    expect(w.db.rows("invoice_drafts")).toHaveLength(0);
  });

  it("stops reading a body sent without its length once it passes the cap", async () => {
    const w = world();
    const { access_token: token } = await connect(w);
    let pulled = 0;
    const chunk = new TextEncoder().encode("a".repeat(16_000));
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          if (pulled > 1_000) controller.close();
          else controller.enqueue(chunk);
        },
      });
    const streamed = (url: string, headers: Record<string, string>) =>
      new Request(url, { method: "POST", headers: { origin: ORIGIN, "x-forwarded-for": address(), ...headers }, body: endless(), duplex: "half" } as RequestInit);

    const draftResponse = await w.run(() =>
      draftsPOST(
        call(token, `${BASE}/api/extension/v1/invoice-drafts`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          body: endless(),
          duplex: "half",
        } as RequestInit)
      )
    );
    expect(draftResponse.status).toBe(413);
    expect(pulled).toBeLessThan(20);

    pulled = 0;
    const tokenResponse = await w.run(() => tokenPOST(streamed(`${BASE}/api/extension/v1/token`, { "content-type": "application/x-www-form-urlencoded" })));
    expect(tokenResponse.status).toBe(400);
    expect(pulled).toBeLessThan(20);

    pulled = 0;
    const revokeResponse = await w.run(() => revokePOST(streamed(`${BASE}/api/extension/v1/revoke`, { "content-type": "application/x-www-form-urlencoded" })));
    expect(revokeResponse.status).toBe(400);
    expect(pulled).toBeLessThan(20);
  });

  it("keeps text Postgres can store: no NUL, no half of a character", async () => {
    const w = world();
    const { access_token: token } = await connect(w);
    const response = await capture(w, token, { source: "selection", text: `${INVOICE_TEXT}\u0000\nNote: \ud83d` });
    expect(response.status).toBe(201);
    const [row] = w.db.rows("invoice_drafts");
    expect(row.raw_text).not.toMatch(/\u0000|\ud83d/);
    expect(JSON.stringify(row.read)).not.toContain("\\u0000");
  });

  it("keeps a picture as a blank draft to type in, and never its bytes", async () => {
    const w = world();
    const { access_token: token } = await connect(w);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const response = await upload(w, token, new File([png], "invoice.png", { type: "image/png" }));
    expect(response.status).toBe(201);
    const { data } = await response.json();
    expect(data).toMatchObject({ source: "file", document: { kind: "image" }, fields: { amount: null }, notes: ["A picture is not read. Type the invoice's fields from it, then send the draft."] });
    expect(w.db.rows("invoice_drafts")[0].raw_text).toBeNull();
  });

  it("takes the person's edits while it is a draft, sends it once, and then refuses edits", async () => {
    const w = world();
    const { access_token: token } = await connect(w);
    const { data: draft } = await (await capture(w, token, { source: "selection", text: INVOICE_TEXT })).json();

    const bad = await patch(w, token, draft.id, { amount: "1,200.00" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toMatch(/^amount: /);
    expect((await patch(w, token, draft.id, { approved: true })).status).toBe(400);

    const edited = await patch(w, token, draft.id, { amount: "210.50", memo: "Hosting, October" });
    expect(edited.status).toBe(200);
    expect((await edited.json()).data.fields).toMatchObject({ amount: "210.50", memo: "Hosting, October" });

    const sent = await send(w, token, draft.id);
    expect(sent.status).toBe(200);
    const { data } = await sent.json();
    expect(data.state).toBe("sent");
    expect(data.reviewUrl).toMatch(/\/o\/northstar\/invoices\?review=captured$/);
    expect(w.actions()).toContain("invoice_draft_captured");
    const captured = w.ledger.find((entry) => entry.p_action === "invoice_draft_captured")!;
    // The entry names the draft and the document, never what was captured.
    expect(JSON.stringify(captured.p_detail)).not.toContain("Northwind");

    expect((await patch(w, token, draft.id, { amount: "1" })).status).toBe(409);
    expect((await send(w, token, draft.id)).status).toBe(200);
    expect(w.db.rows("invoices")).toHaveLength(0);
  });

  it("shows a connection only its own drafts", async () => {
    const w = world();
    const mine = await connect(w);
    const theirs = await connect(w);
    const { data: draft } = await (await capture(w, mine.access_token, { source: "selection", text: INVOICE_TEXT })).json();
    expect((await read(w, mine.access_token, draft.id)).status).toBe(200);
    expect((await read(w, theirs.access_token, draft.id)).status).toBe(404);
    expect((await patch(w, theirs.access_token, draft.id, { amount: "1" })).status).toBe(404);
    expect((await send(w, theirs.access_token, draft.id)).status).toBe(404);
  });

  it("takes five reads a minute per workspace", async () => {
    const w = world();
    const { access_token: token } = await connect(w);
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) statuses.push((await capture(w, token, { source: "selection", text: `${INVOICE_TEXT}\nLine ${index}` })).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe("revocation (C17)", () => {
  it("ends the connection from the extension's Disconnect, and answers 200 to any token", async () => {
    const w = world();
    const tokens = await connect(w);
    const revoke = (token: string) => w.run(() => revokePOST(form(`${BASE}/api/extension/v1/revoke`, { token, client_id: CLIENT })));
    expect((await revoke(tokens.refresh_token)).status).toBe(200);
    expect((await w.run(() => sessionGET(call(tokens.access_token, `${BASE}/api/extension/v1/session`)))).status).toBe(401);
    expect(w.actions()).toContain("extension_disconnected");
    expect((await revoke("vxr_unknown")).status).toBe(200);
  });

  it("records the connections a membership took with it when it ended", async () => {
    const w = world();
    await connect(w);
    const [grant] = w.db.rows("extension_grants");
    await w.run(() => withOrg(w.orgId, () => removeMember({ actorId: APPROVER, userId: OWNER })));
    expect(w.db.rows("extension_grants")).toHaveLength(0);
    const ended = w.ledger.find((entry) => entry.p_action === "extension_disconnected");
    expect(ended?.p_detail).toMatchObject({ by: APPROVER, connectionId: grant.id, client: CLIENT, reason: "member_removed" });
  });

  it("ends a connection from Settings", async () => {
    const w = world();
    const tokens = await connect(w);
    const [grant] = w.db.rows("extension_grants");
    const revoked = await w.run(() => revokeConnection({ orgId: w.orgId, connectionId: grant.id as string, by: OWNER, reason: "settings" }));
    expect(revoked).toBe(true);
    expect((await capture(w, tokens.access_token, { source: "selection", text: INVOICE_TEXT })).status).toBe(401);
  });
});

describe("from draft to bill (C5-C7)", () => {
  const bill = (overrides: Record<string, unknown> = {}) =>
    invoiceInputSchema.parse({
      direction: "payable",
      counterpartyId: COUNTERPARTY,
      amount: "200.00",
      currency: "USDC",
      memo: "INV-2207",
      poReference: "PO-1042",
      goodsReceived: true,
      dueDate: "2026-10-31",
      earlyPayDiscountPct: "",
      discountDeadline: "",
      ...overrides,
    });

  async function sentDraft(w: World) {
    const { access_token: token } = await connect(w);
    const { data } = await (await capture(w, token, { source: "selection", text: INVOICE_TEXT })).json();
    await send(w, token, data.id);
    return data.id as string;
  }

  const asOwner = (w: World) => ({ orgId: w.orgId, userId: OWNER, role: "owner" as const, mode: "sandbox" as const, surface: { kind: "console" as const } });

  it("is never a bill from the extension: its surface cannot add an invoice", async () => {
    const w = world();
    const outcome = await w.run(() =>
      withOrg(w.orgId, async () => {
        const actor = await memberActor(w.orgId, OWNER, { kind: "chrome", connectionId: crypto.randomUUID() });
        return addInvoice(actor!, { invoice: bill(), document: null });
      })
    );
    expect(outcome).toMatchObject({ ok: false, code: "surface" });
    expect(w.db.rows("invoices")).toHaveLength(0);
  });

  it("becomes a bill only through the console's step, which runs the add-invoice command", async () => {
    const w = world();
    const draftId = await sentDraft(w);
    expect(w.db.rows("invoices")).toHaveLength(0);
    const outcome = await w.run(() => withOrg(w.orgId, () => confirmInvoiceDraft(consoleActor({ user: { id: OWNER }, membership: { orgId: w.orgId, role: "owner", mode: "sandbox" } }), { draftId, invoice: bill(), notDuplicate: false })));
    expect(outcome).toMatchObject({ ok: true });
    expect(addInvoice).toHaveBeenCalledTimes(1);
    expect(vi.mocked(addInvoice).mock.calls[0][1]).toMatchObject({ captured: { invoiceDraftId: draftId, invoiceNumber: "INV-2207" } });
    const [invoice] = w.db.rows("invoices");
    expect(invoice).toMatchObject({ counterparty_id: COUNTERPARTY, amount: "200.00", created_by: OWNER });
    const created = w.ledger.find((entry) => entry.p_action === "create_invoice")!;
    expect(created.p_detail).toMatchObject({ via: "chrome", invoiceDraftId: draftId, invoiceNumber: "INV-2207", document: { kind: "text", reader: "heuristic" } });
    expect(w.actions().indexOf("invoice_draft_confirmed")).toBeGreaterThan(w.actions().indexOf("create_invoice"));
    expect(w.db.rows("invoice_drafts")[0]).toMatchObject({ state: "confirmed", invoice_id: invoice.id, raw_text: null, decided_by: OWNER });
    expect(cycleMock).toHaveBeenCalledTimes(1);

    const twice = await w.run(() => withOrg(w.orgId, () => confirmInvoiceDraft(asOwner(w), { draftId, invoice: bill(), notDuplicate: true })));
    expect(twice).toMatchObject({ ok: false, code: "not_found" });
    expect(w.db.rows("invoices")).toHaveLength(1);
  });

  it("adds an invoice a payee sent through its payee link as the member's bill, naming the link (payee invoice link P5)", async () => {
    const w = world();
    const draftId = crypto.randomUUID();
    const link = crypto.randomUUID();
    w.db.rows("invoice_drafts").push({
      id: draftId, org_id: w.orgId, state: "sent", source: "payee_link", document_kind: null, document_sha256: null, supplier_name: "Northwind Hosting",
      invoice_number: "INV-7", amount: "200.00", currency: "USDC", invoice_date: null, due_date: "2026-10-31", po_reference: null, memo: null,
      read: { via: "payee_link", reader: null, warnings: [], documentNotes: [], modelNote: null, counterpartyName: "Northwind Hosting", note: "October hosting", extracted: {} },
      raw_text: null, counterparty_id: COUNTERPARTY, connection_id: null, payee_link_id: link, idempotency_key: link, request_sha256: "a".repeat(64),
      captured_by: null, captured_at: now(), updated_at: now(), sent_at: now(), decided_by: null, decided_at: null, claimed_invoice_id: null, invoice_id: null,
    });
    const outcome = await w.run(() => withOrg(w.orgId, () => confirmInvoiceDraft(asOwner(w), { draftId, invoice: bill({ memo: "INV-7 · October hosting", poReference: "" }), notDuplicate: false })));
    expect(outcome).toMatchObject({ ok: true });
    expect(vi.mocked(addInvoice).mock.calls[0][1]).toMatchObject({ captured: { invoiceDraftId: draftId, invoiceNumber: "INV-7", payeeLinkId: link }, document: null });
    // Whoever adds it is its maker, so the agent's two-person rules treat it as theirs.
    expect(w.db.rows("invoices")[0]).toMatchObject({ created_by: OWNER });
    const created = w.ledger.find((entry) => entry.p_action === "create_invoice")!;
    expect(created.p_detail).toMatchObject({ by: OWNER, via: "payee_link", invoiceDraftId: draftId, invoiceNumber: "INV-7", payeeLinkId: link });
    expect(created.p_detail).not.toHaveProperty("document");
    const confirmed = w.ledger.find((entry) => entry.p_action === "invoice_draft_confirmed")!;
    expect(confirmed.p_summary).toBe("Added an invoice sent through a payee link as a bill for Northwind Hosting");
    expect(w.db.rows("invoice_drafts")[0]).toMatchObject({ state: "confirmed", decided_by: OWNER });
  });

  it("says a possible duplicate before adding, and adds it once the person ticks it is not one", async () => {
    const w = world();
    w.db.rows("invoices").push({ id: crypto.randomUUID(), org_id: w.orgId, direction: "payable", counterparty_id: COUNTERPARTY, amount: 200, currency: "USDC", memo: "INV-2207 hosting", po_reference: "PO-1042", due_date: "2026-10-31T12:00:00Z", status: "paid" });
    const draftId = await sentDraft(w);
    const refused = await w.run(() => withOrg(w.orgId, () => confirmInvoiceDraft(asOwner(w), { draftId, invoice: bill(), notDuplicate: false })));
    expect(refused).toMatchObject({ ok: false, code: "possible_duplicate" });
    expect(w.db.rows("invoice_drafts")[0].state).toBe("sent");
    const added = await w.run(() => withOrg(w.orgId, () => confirmInvoiceDraft(asOwner(w), { draftId, invoice: bill(), notDuplicate: true })));
    expect(added).toMatchObject({ ok: true });
    expect(w.db.rows("invoices")).toHaveLength(2);
  });

  it("puts the draft back when the bill cannot be added", async () => {
    const w = world();
    const draftId = await sentDraft(w);
    const outcome = await w.run(() => withOrg(w.orgId, () => confirmInvoiceDraft(asOwner(w), { draftId, invoice: bill({ counterpartyId: crypto.randomUUID() }), notDuplicate: true })));
    expect(outcome).toMatchObject({ ok: false, code: "counterparty_not_found" });
    expect(w.db.rows("invoice_drafts")[0]).toMatchObject({ state: "sent", decided_by: null });
    expect(w.db.rows("invoice_drafts")[0].raw_text).not.toBeNull();
  });

  it("is refused to an approver, who adds no records", async () => {
    const w = world();
    const draftId = await sentDraft(w);
    const outcome = await w.run(() => withOrg(w.orgId, () => confirmInvoiceDraft({ ...asOwner(w), userId: APPROVER, role: "approver" }, { draftId, invoice: bill(), notDuplicate: true })));
    expect(outcome).toMatchObject({ ok: false, code: "forbidden" });
    expect(addInvoice).not.toHaveBeenCalled();
  });

  it("is discarded with its captured text", async () => {
    const w = world();
    const draftId = await sentDraft(w);
    const outcome = await w.run(() => withOrg(w.orgId, () => discardInvoiceDraft(asOwner(w), { draftId })));
    expect(outcome).toMatchObject({ ok: true });
    expect(w.db.rows("invoice_drafts")[0]).toMatchObject({ state: "discarded", raw_text: null });
    expect(w.actions()).toContain("invoice_draft_discarded");
    expect(w.db.rows("invoices")).toHaveLength(0);
  });

  it("is never discarded by a viewer or an approver", async () => {
    const w = world();
    const draftId = await sentDraft(w);
    for (const role of ["viewer", "approver", "accountant"] as const) {
      const outcome = await w.run(() => withOrg(w.orgId, () => discardInvoiceDraft({ ...asOwner(w), userId: APPROVER, role }, { draftId })));
      expect(outcome, role).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(w.db.rows("invoice_drafts")[0].state).toBe("sent");
  });

  it("keeps a bill that was added when its ledger entry could not be written, and never adds it twice", async () => {
    const w = world({ failLedger: (action) => action === "create_invoice" });
    const draftId = await sentDraft(w);
    const outcome = await w.run(() => withOrg(w.orgId, () => confirmInvoiceDraft(asOwner(w), { draftId, invoice: bill(), notDuplicate: true })));
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.message).toContain("its ledger entry was not recorded");
    const invoices = w.db.rows("invoices");
    expect(invoices).toHaveLength(1);
    // The bill has the id chosen when the person started adding it, and the draft names it.
    expect(w.db.rows("invoice_drafts")[0]).toMatchObject({ state: "confirmed", invoice_id: invoices[0].id, claimed_invoice_id: invoices[0].id, raw_text: null });
    expect(w.actions()).toContain("invoice_draft_confirmed");
    const again = await w.run(() => withOrg(w.orgId, () => confirmInvoiceDraft(asOwner(w), { draftId, invoice: bill(), notDuplicate: true })));
    expect(again).toMatchObject({ ok: false, code: "not_found" });
    expect(w.db.rows("invoices")).toHaveLength(1);
  });
});

describe("drafts kept in the extension (M8)", () => {
  it("takes at most 50 drafts never sent per connection", async () => {
    const w = world();
    const { access_token: token } = await connect(w);
    const [grant] = w.db.rows("extension_grants");
    for (let index = 0; index < 50; index += 1) {
      w.db.rows("invoice_drafts").push({
        id: crypto.randomUUID(), org_id: w.orgId, state: "draft", source: "selection", connection_id: grant.id, idempotency_key: `old-${index}`,
        request_sha256: "a".repeat(64), captured_at: now(),
      });
    }
    const response = await capture(w, token, { source: "selection", text: INVOICE_TEXT });
    expect(response.status).toBe(429);
    expect((await response.json()).error.message).toContain("50 drafts");
    w.db.rows("invoice_drafts")[0].state = "sent";
    expect((await capture(w, token, { source: "selection", text: INVOICE_TEXT })).status).toBe(201);
  });

  it("forgets the matched counterparty when the supplier's name is changed, and only then", async () => {
    const w = world();
    const { access_token: token } = await connect(w);
    const { data } = await (await capture(w, token, { source: "selection", text: INVOICE_TEXT })).json();
    const row = () => w.db.rows("invoice_drafts").find((draft) => draft.id === data.id)!;
    expect(row().counterparty_id).toBe(COUNTERPARTY);
    expect((await patch(w, token, data.id, { ...data.fields, amount: "210.00" })).status).toBe(200);
    expect(row().counterparty_id).toBe(COUNTERPARTY);
    expect((await patch(w, token, data.id, { ...data.fields, supplierName: "Southwind Hosting" })).status).toBe(200);
    expect(row().counterparty_id).toBeNull();
  });
});
