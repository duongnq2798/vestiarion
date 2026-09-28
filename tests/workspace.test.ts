import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { isValidSlug } from "@/lib/auth/org-paths";
import { ledgerKeyId } from "@/lib/ledger-keys";
import { createWorkspace, slugFromName, WorkspaceLimitError } from "@/lib/platform/workspace";
import { decryptSecret, parseMasterKeys, type SecretEnvelope } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

const USER = "7a1d2c3b-0000-4000-8000-00000000c0de";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

function claimsOf(request: RecordedRequest) {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "null");
}

const SLUG_CLASH: FakeReply = {
  status: 409,
  body: {
    code: "23505",
    message: 'duplicate key value violates unique constraint "orgs_slug_key"',
    details: "Key (slug) already exists.",
    hint: null,
  },
};

/**
 * PostgREST as `createWorkspace` meets it: the slug check, `create_org`, the
 * scope entry's read of the new row, and the tenant writes after it. The row
 * the scope reads carries whatever envelope `create_org` last received, so the
 * scope decrypts the key that was just generated rather than a fixture.
 */
function workspaceFake(options: {
  takenSlugs?: string[];
  createOrg?: (attempt: number) => FakeReply | undefined;
  /** Answers first, for a failure somewhere after `create_org`. */
  fail?: (request: RecordedRequest) => FakeReply | undefined;
  config?: typeof config;
} = {}) {
  let created: Record<string, unknown> | undefined;
  let createOrgCalls = 0;
  const fake = fakeSupabase((request) => {
    const failure = options.fail?.(request);
    if (failure) return failure;
    if (request.path === "/rest/v1/orgs" && request.params.has("slug")) {
      const slug = request.params.get("slug")!.replace(/^eq\./, "");
      return { body: options.takenSlugs?.includes(slug) ? [{ id: "5d0f3a2e-8c1b-4f7a-9e6d-00000000beef" }] : [] };
    }
    if (request.path === "/rest/v1/rpc/create_org") {
      const failure = options.createOrg?.(createOrgCalls++);
      if (failure) return failure;
      const body = request.body as Record<string, unknown>;
      created = {
        id: body.p_org_id,
        slug: body.p_slug,
        name: body.p_name,
        mode: "sandbox",
        ledger_signing_key_enc: body.p_ledger_key_enc,
        circle_api_key_enc: null,
        circle_entity_secret_enc: null,
      };
      return { body: created };
    }
    if (request.method === "GET" && request.path === "/rest/v1/orgs" && request.params.has("id")) {
      if (created && request.params.get("id") === `eq.${created.id}`) return { body: created };
      return { status: 406, body: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
    }
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      return {
        body: { seq: 1, id: "e1", ts: "2026-09-28T00:00:00Z", actor: "human", domain: "system", action: "org_created", summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null },
      };
    }
    return { body: [] };
  });
  return {
    fake,
    run: <T>(fn: () => Promise<T>) => runWith({ config: options.config ?? config, db: fake.client, fetch: fake.fetch }, fn),
  };
}

const DB_ERROR = (message: string): FakeReply => ({ status: 500, body: { code: "XX000", message, details: null, hint: null } });

function deletes(requests: RecordedRequest[]) {
  return requests.filter((request) => request.method === "DELETE").map((request) => [request.path, request.params.toString()]);
}

function rpcBodies(requests: RecordedRequest[], name: string) {
  return requests.filter((request) => request.path === `/rest/v1/rpc/${name}`).map((request) => request.body as Record<string, unknown>);
}

describe("slugFromName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugFromName("Northstar Studio")).toBe("northstar-studio");
  });

  it("folds accents to their base letters and drops the rest", () => {
    expect(slugFromName("  Café Ümlaut & Co.  ")).toBe("cafe-umlaut-co");
  });

  it("falls back to a generic slug when nothing Latin survives", () => {
    expect(slugFromName("日本")).toBe("workspace");
  });

  it("cuts a long name to 36 characters without leaving a trailing hyphen", () => {
    const name = "Northstar Studio And Partners International Holdings Limited";
    expect(name).toHaveLength(60);
    const slug = slugFromName(name);
    expect(slug.length).toBeLessThanOrEqual(36);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("always produces a valid slug", () => {
    for (const name of ["Northstar Studio", "  Café Ümlaut & Co.  ", "日本", "a", "--", "x".repeat(60), "Ab Cd Ef Gh Ij Kl Mn Op Qr St Uv Wx Yz 12", "A-"]) {
      expect(isValidSlug(slugFromName(name)), name).toBe(true);
    }
  });
});

describe("createWorkspace", () => {
  it("creates the organization with its own sealed key, two simulated accounts and a first ledger entry", async () => {
    const { fake, run } = workspaceFake();
    const result = await run(() => createWorkspace({ userId: USER, name: "  Northstar Studio  " }));

    const [createOrg] = rpcBodies(fake.requests, "create_org");
    const { p_ledger_key_enc: envelope, ...args } = createOrg;
    expect(args).toEqual({ p_org_id: expect.stringMatching(UUID), p_user_id: USER, p_name: "Northstar Studio", p_slug: "northstar-studio" });
    const orgId = args.p_org_id as string;

    // Assert on the key without ever handing it to a matcher that would print it.
    const pem = decryptSecret(envelope as SecretEnvelope, { orgId, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS));
    expect(pem.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
    const privateKey = crypto.createPrivateKey(pem);
    expect(privateKey.asymmetricKeyType).toBe("ed25519");

    const accounts = fake.requests.filter((request) => request.path === "/rest/v1/accounts");
    expect(accounts.map((request) => [request.method, request.body])).toEqual([
      ["POST", [
        { name: "Operating (simulated)", kind: "operating", chain: "ARC-TESTNET", balance: 10000, org_id: orgId },
        { name: "Reserve (simulated)", kind: "reserve", chain: "ARC-TESTNET", balance: 0, org_id: orgId },
      ]],
    ]);

    const appends = fake.requests.filter((request) => request.path === "/rest/v1/rpc/append_ledger_entry");
    expect(appends).toHaveLength(1);
    expect(appends[0].body).toMatchObject({
      p_org_id: orgId,
      p_actor: "human",
      p_domain: "system",
      p_action: "org_created",
      p_summary: "Workspace created: Northstar Studio",
      p_detail: { by: USER, slug: "northstar-studio", mode: "sandbox", ledgerKeyId: ledgerKeyId(privateKey) },
      p_signing_key_id: ledgerKeyId(privateKey),
    });
    expect(claimsOf(appends[0])).toMatchObject({ role: "vestiarion_tenant", org_id: orgId, sub: USER });

    expect(result).toEqual({ orgId, slug: "northstar-studio" });
  });

  it("checks the slug before creating anything, and suffixes one already taken", async () => {
    const { fake, run } = workspaceFake({ takenSlugs: ["northstar-studio"] });
    const result = await run(() => createWorkspace({ userId: USER, name: "Northstar Studio", random: () => "beef" }));
    const checked = fake.requests.filter((request) => request.path === "/rest/v1/orgs" && request.params.has("slug"));
    expect(checked.map((request) => request.params.get("slug"))).toEqual(["eq.northstar-studio", "eq.northstar-studio-beef"]);
    expect(rpcBodies(fake.requests, "create_org").map((body) => body.p_slug)).toEqual(["northstar-studio-beef"]);
    expect(result.slug).toBe("northstar-studio-beef");
  });

  it("retries with a suffix when the slug is taken between the check and the insert", async () => {
    const { fake, run } = workspaceFake({ createOrg: (attempt) => (attempt === 0 ? SLUG_CLASH : undefined) });
    const result = await run(() => createWorkspace({ userId: USER, name: "Northstar Studio", random: () => "a1b2" }));
    const calls = rpcBodies(fake.requests, "create_org");
    expect(calls.map((body) => body.p_slug)).toEqual(["northstar-studio", "northstar-studio-a1b2"]);
    // A fresh organization, and a fresh key sealed to it, for every attempt.
    expect(calls[0].p_org_id).not.toBe(calls[1].p_org_id);
    expect(result).toEqual({ orgId: calls[1].p_org_id, slug: "northstar-studio-a1b2" });
  });

  it("gives up after five clashes, and enters no organization", async () => {
    let n = 0;
    const { fake, run } = workspaceFake({ createOrg: () => SLUG_CLASH });
    await expect(run(() => createWorkspace({ userId: USER, name: "Northstar Studio", random: () => (n++).toString(16).padStart(4, "0") })))
      .rejects.toThrow("Could not find a free address for this workspace; try a different name.");
    expect(rpcBodies(fake.requests, "create_org")).toHaveLength(5);
    expect(fake.requests.some((request) => request.path === "/rest/v1/accounts")).toBe(false);
  });

  it("reports the per-person limit as a WorkspaceLimitError", async () => {
    const { fake, run } = workspaceFake({
      createOrg: () => ({ status: 400, body: { code: "P0001", message: "org_limit_reached: at most 3 workspaces per person", details: null, hint: null } }),
    });
    const attempt = run(() => createWorkspace({ userId: USER, name: "Northstar Studio" }));
    await expect(attempt).rejects.toBeInstanceOf(WorkspaceLimitError);
    await expect(attempt).rejects.toThrow("You already have 3 workspaces, the most one person can create.");
    expect(rpcBodies(fake.requests, "create_org")).toHaveLength(1);
    expect(fake.requests.some((request) => request.path === "/rest/v1/accounts")).toBe(false);
  });

  it("passes any other database error through", async () => {
    const { run } = workspaceFake({
      createOrg: () => ({ status: 500, body: { code: "XX000", message: "something else broke", details: null, hint: null } }),
    });
    await expect(run(() => createWorkspace({ userId: USER, name: "Northstar Studio" }))).rejects.toThrow("something else broke");
  });

  it.each([["empty", ""], ["whitespace", "   \t "], ["over 80 characters", "x".repeat(81)]])(
    "refuses a name that is %s before any request is made",
    async (_label, name) => {
      const { fake, run } = workspaceFake();
      await expect(run(() => createWorkspace({ userId: USER, name }))).rejects.toThrow(/name/i);
      expect(fake.requests).toEqual([]);
    }
  );

  it("accepts a name of exactly 80 characters once trimmed", async () => {
    const { run } = workspaceFake();
    await expect(run(() => createWorkspace({ userId: USER, name: `  ${"x".repeat(80)}  ` }))).resolves.toMatchObject({ slug: "x".repeat(36) });
  });

  it("refuses to create anything when no master key can seal the new key", async () => {
    delete process.env.VESTIARION_MASTER_KEYS;
    const { fake, run } = workspaceFake();
    await expect(run(() => createWorkspace({ userId: USER, name: "Northstar Studio" }))).rejects.toThrow(/VESTIARION_MASTER_KEYS/);
    expect(fake.requests).toEqual([]);
  });

  it("creates nothing on a deployment that could not enter the new organization", async () => {
    const { fake, run } = workspaceFake({ config: configFromEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    }) });
    await expect(run(() => createWorkspace({ userId: USER, name: "Northstar Studio" }))).rejects.toThrow(/SUPABASE_JWT_SECRET/);
    expect(fake.requests).toEqual([]);
  });

  it("calls create_org as the platform, never with a tenant token", async () => {
    const { fake, run } = workspaceFake();
    await run(() => createWorkspace({ userId: USER, name: "Northstar Studio" }));
    const createOrg = fake.requests.find((request) => request.path === "/rest/v1/rpc/create_org")!;
    // fakeSupabase() builds its service client with the key "test-service-role".
    expect(createOrg.headers.get("authorization")).toBe("Bearer test-service-role");
  });

  it("never leaves a double hyphen before the suffix", async () => {
    // The base slug is 34 a's, a hyphen and "b": cutting it to 35 for the
    // suffix would otherwise end it on the hyphen.
    const base = `${"a".repeat(34)}-b`;
    const { run } = workspaceFake({ takenSlugs: [base] });
    const result = await run(() => createWorkspace({ userId: USER, name: `${"a".repeat(34)} bcd`, random: () => "beef" }));
    expect(result.slug).toBe(`${"a".repeat(34)}-beef`);
  });
});

describe("a workspace whose setup fails", () => {
  let logged: unknown[][] = [];
  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { logged.push(args); });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is removed when the accounts cannot be written, and the original error surfaces", async () => {
    const { fake, run } = workspaceFake({
      fail: (request) => (request.method === "POST" && request.path === "/rest/v1/accounts" ? DB_ERROR("accounts insert failed") : undefined),
    });
    await expect(run(() => createWorkspace({ userId: USER, name: "Northstar Studio" }))).rejects.toThrow("accounts insert failed");
    const [{ p_org_id: orgId }] = rpcBodies(fake.requests, "create_org");
    expect(deletes(fake.requests)).toContainEqual(["/rest/v1/orgs", `id=eq.${orgId}`]);
    expect(logged).toEqual([["workspace setup failed; rolled back", orgId]]);
  });

  it("has its accounts and then itself removed when the first ledger entry cannot be written", async () => {
    const { fake, run } = workspaceFake({
      fail: (request) => (request.path === "/rest/v1/rpc/append_ledger_entry" ? DB_ERROR("append failed") : undefined),
    });
    await expect(run(() => createWorkspace({ userId: USER, name: "Northstar Studio" }))).rejects.toThrow("append failed");
    const [{ p_org_id: orgId }] = rpcBodies(fake.requests, "create_org");
    expect(deletes(fake.requests)).toEqual([
      ["/rest/v1/accounts", `org_id=eq.${orgId}`],
      ["/rest/v1/orgs", `id=eq.${orgId}`],
    ]);
    const accountsDelete = fake.requests.find((request) => request.method === "DELETE" && request.path === "/rest/v1/accounts")!;
    expect(claimsOf(accountsDelete)).toMatchObject({ role: "vestiarion_tenant", org_id: orgId, sub: USER });
  });

  it("still surfaces the original error when the clean-up itself fails", async () => {
    const { run } = workspaceFake({
      fail: (request) => {
        if (request.path === "/rest/v1/rpc/append_ledger_entry") return DB_ERROR("append failed");
        if (request.method === "DELETE") return DB_ERROR("delete refused");
        return undefined;
      },
    });
    await expect(run(() => createWorkspace({ userId: USER, name: "Northstar Studio" }))).rejects.toThrow("append failed");
  });
});
