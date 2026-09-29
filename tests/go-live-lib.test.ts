import crypto from "node:crypto";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
} from "@circle-fin/developer-controlled-wallets";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import type { CircleClient, CircleClientFactory } from "@/lib/circle/check";
import { TREASURY_WALLET_SET } from "@/lib/circle/provision";
import { connectCircle, createWallets, goLive, GoLiveError, goLiveStatus, operatingBalance } from "@/lib/platform/go-live";
import { decryptSecret, encryptSecret, parseMasterKeys, type SecretEnvelope } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/lib/platform/go-live.ts` over a real supabase-js client whose network
 * is a small stateful PostgREST — the organization row, its accounts and its
 * ledger — and a fake Circle client that throws the SDK's own error classes.
 * Scopes are entered through the real `withOrg`, so the organization's
 * configuration is decrypted from the row exactly as in production.
 */

const ORG = "6a1f0c2e-8c1b-4f7a-9e6d-0000000000a1";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a7";
const API_KEY = "TEST_API_KEY:golive-key-id:golive-key-secret-value";
const ENTITY_SECRET = "c0ffee".repeat(10) + "abcd";
const OLD_API_KEY = "TEST_API_KEY:old-key-id:old-key-secret-value";
const OLD_ENTITY_SECRET = "0ld5".repeat(16);
const REQUEST = { url: "/v1/w3s/wallets/x", method: "GET" };
const LEAKY = `Bearer ${API_KEY} ${ENTITY_SECRET}`;

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const OTHER_MASTER_KEYS = `t9:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const seal = (value: string, column: string, keys = MASTER_KEYS): SecretEnvelope =>
  encryptSecret(value, { orgId: ORG, column }, parseMasterKeys(keys));

interface AccountRow {
  id: string;
  name: string;
  kind: "operating" | "reserve" | "chain";
  chain: string;
  address: string | null;
  circle_wallet_id: string | null;
}

interface State {
  org: {
    mode: "sandbox" | "live";
    ledger_signing_key_enc: SecretEnvelope;
    circle_api_key_enc: SecretEnvelope | null;
    circle_entity_secret_enc: SecretEnvelope | null;
  };
  accounts: AccountRow[];
  wentLive: Array<{ ts: string }>;
}

const OPERATING_ADDRESS = "0x" + "ab".repeat(20);

function sandbox(overrides: Partial<State["org"]> = {}): State {
  return {
    org: {
      mode: "sandbox",
      ledger_signing_key_enc: seal(LEDGER_PEM, "ledger_signing_key_enc"),
      circle_api_key_enc: null,
      circle_entity_secret_enc: null,
      ...overrides,
    },
    accounts: [
      { id: "acct-operating", name: "Operating (simulated)", kind: "operating", chain: "ARC-TESTNET", address: null, circle_wallet_id: null },
      { id: "acct-reserve", name: "Reserve (simulated)", kind: "reserve", chain: "ARC-TESTNET", address: null, circle_wallet_id: null },
    ],
    wentLive: [],
  };
}

function connected(overrides: Partial<State["org"]> = {}): State {
  return sandbox({
    circle_api_key_enc: seal(OLD_API_KEY, "circle_api_key_enc"),
    circle_entity_secret_enc: seal(OLD_ENTITY_SECRET, "circle_entity_secret_enc"),
    ...overrides,
  });
}

function withWallets(state: State): State {
  state.accounts = [
    { id: "acct-operating", name: "Operating", kind: "operating", chain: "ARC-TESTNET", address: OPERATING_ADDRESS, circle_wallet_id: "wallet-operating" },
    { id: "acct-reserve", name: "Reserve", kind: "reserve", chain: "ARC-TESTNET", address: "0x" + "cd".repeat(20), circle_wallet_id: "wallet-reserve" },
  ];
  return state;
}

/** The founding workspace: live since before this flow existed — credentials, wallets, and no `workspace_went_live` entry. */
function founding(): State {
  return withWallets(connected({ mode: "live" }));
}

const eqValue = (request: RecordedRequest, column: string) => request.params.get(column)?.replace(/^eq\./, "");

/** A PostgREST projection of the org row: plain columns, and `alias:column->>k` for an envelope's key id. */
function projectOrg(state: State, select: string): Record<string, unknown> {
  const row: Record<string, unknown> = { id: ORG, slug: "northstar", name: "Northstar", ...state.org };
  const out: Record<string, unknown> = {};
  for (const item of select.split(",").map((part) => part.trim())) {
    const json = /^(\w+):(\w+)->>(\w+)$/.exec(item);
    if (json) {
      const [, alias, column, key] = json;
      out[alias] = (row[column] as Record<string, unknown> | null)?.[key] ?? null;
    } else {
      out[item] = row[item];
    }
  }
  return out;
}

function one(request: RecordedRequest, rows: unknown[]): FakeReply {
  const asObject = request.headers.get("accept")?.includes("vnd.pgrst.object");
  return { body: asObject ? rows[0] : rows };
}

function database(state: State, options: { orgUpdateMatchesNothing?: boolean } = {}) {
  const fake = fakeSupabase((request): FakeReply => {
    if (request.path === "/rest/v1/orgs" && request.method === "GET") {
      return one(request, [projectOrg(state, request.params.get("select") ?? "*")]);
    }
    if (request.path === "/rest/v1/orgs" && request.method === "PATCH") {
      const mode = eqValue(request, "mode");
      if (options.orgUpdateMatchesNothing || eqValue(request, "id") !== ORG || (mode && mode !== state.org.mode)) return { body: [] };
      Object.assign(state.org, request.body);
      return { body: [{ id: ORG }] };
    }
    if (request.path === "/rest/v1/accounts" && request.method === "GET") {
      const kind = eqValue(request, "kind");
      return one(request, state.accounts.filter((account) => !kind || account.kind === kind));
    }
    if (request.path === "/rest/v1/accounts" && request.method === "PATCH") {
      const account = state.accounts.find((row) => row.id === eqValue(request, "id"));
      if (!account || account.circle_wallet_id) return { body: [] };
      Object.assign(account, request.body);
      return { body: [{ id: account.id }] };
    }
    if (request.path === "/rest/v1/ledger_entries") {
      return { body: eqValue(request, "action") === "workspace_went_live" ? [...state.wentLive].reverse().slice(0, 1) : [] };
    }
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      return {
        body: {
          seq: 1, id: "e1", ts: "2026-09-30T00:00:00Z", actor: "human", domain: "system", action: "x",
          summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
        },
      };
    }
    throw new Error(`unexpected request ${request.method} ${request.path}`);
  });
  return {
    fake,
    /** Inside the organization's scope, as a server action runs after `inOrg`. */
    inScope: <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn, { userId: ACTOR })),
    /** Outside any organization's scope, as a script would call it. */
    unscoped: <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn),
  };
}

function circle(options: {
  sets?: Array<{ id: string; name?: string }>;
  wallets?: Record<string, { id: string; walletSetId: string; address: string }>;
  getWallet?: (id: string) => Promise<unknown>;
  listWalletSets?: () => Promise<unknown>;
  createWallets?: () => Promise<unknown>;
} = {}) {
  const credentials: Array<{ apiKey: string; entitySecret: string }> = [];
  let walletCalls = 0;
  const listWalletSets = vi.fn(options.listWalletSets ?? (async () => ({ data: { walletSets: options.sets ?? [] } })));
  const createWalletSet = vi.fn(async ({ name }: { name: string }) => ({ data: { walletSet: { id: "set-new", name } } }));
  const createWallets = vi.fn(
    options.createWallets ??
      (async () => {
        walletCalls += 1;
        return { data: { wallets: [{ id: `wallet-${walletCalls}`, address: `0x${String(walletCalls).padStart(40, "0")}` }] } };
      })
  );
  const getWallet = vi.fn(
    options.getWallet
      ? ({ id }: { id: string }) => options.getWallet!(id)
      : async ({ id }: { id: string }) => {
          const wallet = options.wallets?.[id];
          if (!wallet) throw new NotFoundError({ ...REQUEST, status: 404, message: LEAKY });
          return { data: { wallet } };
        }
  );
  const client = { listWalletSets, createWalletSet, createWallets, getWallet } as unknown as CircleClient;
  const factory = vi.fn((given: { apiKey: string; entitySecret: string }) => {
    credentials.push(given);
    return client;
  }) as unknown as CircleClientFactory;
  return { factory, credentials, listWalletSets, createWalletSet, createWallets, getWallet };
}

/** The same Circle entity as the founding workspace's: its treasury set, and its operating wallet in it. */
const SAME_ENTITY = {
  sets: [{ id: "set-other", name: "something-else" }, { id: "set-treasury", name: TREASURY_WALLET_SET }],
  wallets: { "wallet-operating": { id: "wallet-operating", walletSetId: "set-treasury", address: OPERATING_ADDRESS.toUpperCase().replace("0X", "0x") } },
};

const orgPatches = (fake: ReturnType<typeof fakeSupabase>) =>
  fake.requests.filter((request) => request.method === "PATCH" && request.path === "/rest/v1/orgs");
const appends = (fake: ReturnType<typeof fakeSupabase>) =>
  fake.requests
    .filter((request) => request.path === "/rest/v1/rpc/append_ledger_entry")
    .map((request) => request.body as Record<string, unknown>);

const logged: string[] = [];
const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;

beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 6 }))).join(" "));
    });
  }
});

afterEach(() => {
  for (const line of logged) {
    for (const secret of [API_KEY, ENTITY_SECRET, OLD_API_KEY, OLD_ENTITY_SECRET]) expect(line).not.toContain(secret);
  }
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function refusal(work: Promise<unknown>): Promise<GoLiveError> {
  const outcome = await work.then(
    () => undefined,
    (error: unknown) => error
  );
  expect(outcome).toBeInstanceOf(GoLiveError);
  const text = inspect(outcome, { depth: 6 });
  for (const secret of [API_KEY, ENTITY_SECRET]) expect(text).not.toContain(secret);
  return outcome as GoLiveError;
}

describe("GoLiveError", () => {
  it.each([
    ["invalid", "Paste both the API key and the entity secret."],
    ["key_rejected", "Circle did not accept this API key."],
    ["unreachable", "Could not reach Circle; try again."],
    ["different_entity", "This workspace is live; its wallets belong to the connected Circle account."],
    ["not_connected", "Connect Circle first."],
    ["entity_secret_rejected", "Circle did not accept the entity secret; reconnect with the right one."],
    ["no_wallets", "Create the treasury wallets first."],
    ["already_live", "This workspace is already live."],
  ] as const)("%s says %j", (code, message) => {
    const error = new GoLiveError(code);
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
  });
});

describe("connectCircle", () => {
  it("checks the trimmed key, stores both envelopes in one update, and records circle_connected with ids only", async () => {
    const state = sandbox();
    const { fake, inScope } = database(state);
    const fakeCircle = circle();

    await inScope(() =>
      connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: `  ${API_KEY}\n`, entitySecret: `\t${ENTITY_SECRET} `, client: fakeCircle.factory })
    );

    expect(fakeCircle.credentials[0]).toEqual({ apiKey: API_KEY, entitySecret: ENTITY_SECRET });
    expect(fakeCircle.listWalletSets).toHaveBeenCalledTimes(1);
    expect(fakeCircle.getWallet).not.toHaveBeenCalled();

    const [update, ...others] = orgPatches(fake);
    expect(others).toEqual([]);
    expect(update.params.get("id")).toBe(`eq.${ORG}`);
    expect(update.params.get("mode")).toBe("eq.sandbox");
    const body = update.body as { circle_api_key_enc: SecretEnvelope; circle_entity_secret_enc: SecretEnvelope };
    expect(Object.keys(body).sort()).toEqual(["circle_api_key_enc", "circle_entity_secret_enc"]);

    const keys = parseMasterKeys(MASTER_KEYS);
    expect(decryptSecret(body.circle_api_key_enc, { orgId: ORG, column: "circle_api_key_enc" }, keys)).toBe(API_KEY);
    expect(decryptSecret(body.circle_entity_secret_enc, { orgId: ORG, column: "circle_entity_secret_enc" }, keys)).toBe(ENTITY_SECRET);
    // Bound to their column and their organization: moved anywhere else, they do not open.
    expect(() => decryptSecret(body.circle_api_key_enc, { orgId: ORG, column: "circle_entity_secret_enc" }, keys)).toThrow();
    expect(() => decryptSecret(body.circle_entity_secret_enc, { orgId: ORG, column: "circle_api_key_enc" }, keys)).toThrow();
    expect(() =>
      decryptSecret(body.circle_api_key_enc, { orgId: "6a1f0c2e-8c1b-4f7a-9e6d-0000000000ff", column: "circle_api_key_enc" }, keys)
    ).toThrow();

    const sent = JSON.stringify(fake.requests.map((request) => ({ params: request.params.toString(), body: request.body })));
    expect(sent).not.toContain(API_KEY);
    expect(sent).not.toContain(ENTITY_SECRET);

    const entries = appends(fake);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ p_org_id: ORG, p_action: "circle_connected", p_domain: "system", p_actor: "human" });
    expect(entries[0].p_detail).toEqual({ by: ACTOR });
  });

  it("records circle_reconnected when credentials were already stored", async () => {
    const { fake, inScope } = database(connected());
    await inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: circle().factory }));
    expect(appends(fake).map((entry) => [entry.p_action, entry.p_detail])).toEqual([["circle_reconnected", { by: ACTOR }]]);
  });

  it("appends its ledger entry in the organization's own scope when called from outside one", async () => {
    const { fake, unscoped } = database(sandbox());
    await unscoped(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: circle().factory }));
    expect(appends(fake).map((entry) => entry.p_action)).toEqual(["circle_connected"]);
  });

  it.each([
    ["an empty key", "", ENTITY_SECRET],
    ["an empty secret", API_KEY, ""],
    ["a blank key", "   \n", ENTITY_SECRET],
    ["a key over 512 characters", "k".repeat(513), ENTITY_SECRET],
    ["a secret over 512 characters", API_KEY, "a".repeat(513)],
  ])("refuses %s as invalid, before calling Circle or storing anything", async (_label, apiKey, entitySecret) => {
    const { fake, inScope } = database(sandbox());
    const fakeCircle = circle();
    const check = vi.fn();

    const error = await refusal(inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey, entitySecret, check, client: fakeCircle.factory })));

    expect(error.code).toBe("invalid");
    expect(check).not.toHaveBeenCalled();
    expect(fakeCircle.factory).not.toHaveBeenCalled();
    expect(orgPatches(fake)).toEqual([]);
    expect(appends(fake)).toEqual([]);
  });

  it("accepts values of exactly 512 characters", async () => {
    const { fake, inScope } = database(sandbox());
    await inScope(() =>
      connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: "k".repeat(512), entitySecret: "a".repeat(512), check: async () => "ok" })
    );
    expect(orgPatches(fake)).toHaveLength(1);
  });

  it.each([
    ["rejected", "key_rejected"],
    ["unreachable", "unreachable"],
  ] as const)("maps a %s key check to %s and stores nothing", async (verdict, code) => {
    const { fake, inScope } = database(sandbox());
    const check = vi.fn(async () => verdict);

    const error = await refusal(inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, check })));

    expect(error.code).toBe(code);
    expect(check).toHaveBeenCalledWith(API_KEY, ENTITY_SECRET, expect.any(Function));
    expect(orgPatches(fake)).toEqual([]);
    expect(appends(fake)).toEqual([]);
  });

  it("maps a real 401 from Circle's key check to key_rejected, without leaking the SDK's message", async () => {
    const { fake, inScope } = database(sandbox());
    const fakeCircle = circle({ listWalletSets: () => Promise.reject(new UnauthorizedError({ ...REQUEST, status: 401, message: LEAKY })) });
    const error = await refusal(
      inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: fakeCircle.factory }))
    );
    expect(error.code).toBe("key_rejected");
    expect(orgPatches(fake)).toEqual([]);
  });

  it("stores nothing when the workspace's mode changed between the read and the write", async () => {
    const { fake, inScope } = database(sandbox(), { orgUpdateMatchesNothing: true });
    const outcome = await inScope(() =>
      connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: circle().factory })
    ).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(inspect(outcome)).not.toContain(API_KEY);
    expect(appends(fake)).toEqual([]);
  });

  describe("on a live workspace (Review Focus 5)", () => {
    it("allows the same Circle entity: the treasury set is listed and the operating wallet is readable, and in it", async () => {
      const state = founding();
      const { fake, inScope } = database(state);
      const fakeCircle = circle(SAME_ENTITY);

      await inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: fakeCircle.factory }));

      // Every Circle call used the new credentials.
      for (const given of fakeCircle.credentials) expect(given).toEqual({ apiKey: API_KEY, entitySecret: ENTITY_SECRET });
      expect(fakeCircle.getWallet).toHaveBeenCalledWith({ id: "wallet-operating" });
      expect(fakeCircle.createWalletSet).not.toHaveBeenCalled();
      expect(fakeCircle.createWallets).not.toHaveBeenCalled();
      const [update] = orgPatches(fake);
      expect(update.params.get("mode")).toBe("eq.live");
      expect(state.org.mode).toBe("live");
      expect(decryptSecret(state.org.circle_api_key_enc!, { orgId: ORG, column: "circle_api_key_enc" }, parseMasterKeys(MASTER_KEYS))).toBe(API_KEY);
      expect(appends(fake).map((entry) => [entry.p_action, entry.p_detail])).toEqual([["circle_reconnected", { by: ACTOR }]]);
    });

    it.each([
      ["the operating wallet is not found in the new entity", { ...SAME_ENTITY, wallets: {} }],
      ["the new entity has no treasury wallet set", { ...SAME_ENTITY, sets: [{ id: "set-other", name: "something-else" }] }],
      [
        "the operating wallet is in another set",
        { ...SAME_ENTITY, wallets: { "wallet-operating": { id: "wallet-operating", walletSetId: "set-other", address: OPERATING_ADDRESS } } },
      ],
      [
        "the wallet's address is not the stored one",
        { ...SAME_ENTITY, wallets: { "wallet-operating": { id: "wallet-operating", walletSetId: "set-treasury", address: "0x" + "99".repeat(20) } } },
      ],
      [
        "Circle refuses to read the wallet",
        { ...SAME_ENTITY, getWallet: () => Promise.reject(new UnauthorizedError({ ...REQUEST, status: 401, message: LEAKY })) },
      ],
    ])("refuses a different entity when %s, storing nothing", async (_label, entity) => {
      const state = founding();
      const before = { ...state.org };
      const { fake, inScope } = database(state);

      const error = await refusal(
        inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: circle(entity).factory }))
      );

      expect(error.code).toBe("different_entity");
      expect(error.message).toBe("This workspace is live; its wallets belong to the connected Circle account.");
      expect(orgPatches(fake)).toEqual([]);
      expect(state.org).toEqual(before);
      expect(appends(fake)).toEqual([]);
    });

    it("refuses when the operating account has no wallet to prove the entity with", async () => {
      const state = connected({ mode: "live" });
      const { fake, inScope } = database(state);
      const error = await refusal(
        inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: circle(SAME_ENTITY).factory }))
      );
      expect(error.code).toBe("different_entity");
      expect(orgPatches(fake)).toEqual([]);
    });

    it("says unreachable, and stores nothing, when Circle fails to answer the proof", async () => {
      const { fake, inScope } = database(founding());
      const fakeCircle = circle({
        ...SAME_ENTITY,
        getWallet: () => Promise.reject(new InternalServerError({ ...REQUEST, status: 500, message: LEAKY })),
      });
      const error = await refusal(
        inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: fakeCircle.factory }))
      );
      expect(error.code).toBe("unreachable");
      expect(orgPatches(fake)).toEqual([]);
    });

    it("gives up on a getWallet Circle does not answer within 15 s", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { fake, inScope } = database(founding());
      const fakeCircle = circle({ ...SAME_ENTITY, getWallet: () => new Promise<never>(() => {}) });
      let outcome: unknown;
      const pending = inScope(() =>
        connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: fakeCircle.factory })
      ).then(
        (value) => (outcome = value),
        (error: unknown) => (outcome = error)
      );

      // The database reads and the key check come first; let them settle without moving the clock.
      for (let turn = 0; turn < 200 && fakeCircle.getWallet.mock.calls.length === 0; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(fakeCircle.getWallet).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(outcome).toBeInstanceOf(GoLiveError);
      expect((outcome as GoLiveError).code).toBe("unreachable");
      expect(orgPatches(fake)).toEqual([]);
    });
  });
});

describe("createWallets", () => {
  it("refuses a workspace with no credentials, before any Circle call", async () => {
    const { fake, inScope } = database(sandbox());
    const fakeCircle = circle();
    const error = await refusal(inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })));
    expect(error.code).toBe("not_connected");
    expect(fakeCircle.factory).not.toHaveBeenCalled();
    expect(fake.requests.filter((request) => request.method === "PATCH")).toEqual([]);
  });

  it("refuses the founding workspace (live) without re-provisioning", async () => {
    const { fake, inScope } = database(founding());
    const fakeCircle = circle();
    const error = await refusal(inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })));
    expect(error.code).toBe("already_live");
    expect(fakeCircle.factory).not.toHaveBeenCalled();
    expect(fake.requests.filter((request) => request.method === "PATCH")).toEqual([]);
  });

  it("uses credentials stored moments earlier, even from a scope entered before they were", async () => {
    const state = sandbox();
    const { fake, inScope } = database(state);
    const fakeCircle = circle({ sets: [{ id: "set-treasury", name: TREASURY_WALLET_SET }] });

    const result = await inScope(async () => {
      await connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: fakeCircle.factory });
      return createWallets({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory });
    });

    expect(result).toEqual({ created: 2, skipped: 0 });
    expect(fakeCircle.credentials.at(-1)).toEqual({ apiKey: API_KEY, entitySecret: ENTITY_SECRET });
    expect(state.accounts.map((account) => [account.name, account.circle_wallet_id])).toEqual([
      ["Operating", "wallet-1"],
      ["Reserve", "wallet-2"],
    ]);
    const entries = appends(fake);
    expect(entries.map((entry) => entry.p_action)).toEqual(["circle_connected", "treasury_wallets_created"]);
    expect(entries[1].p_detail).toEqual({ by: ACTOR, accounts: 2 });
  });

  it("records nothing when every account already has a wallet", async () => {
    const { fake, inScope } = database(withWallets(connected()));
    const fakeCircle = circle();
    await expect(inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory }))).resolves.toEqual({
      created: 0,
      skipped: 2,
    });
    expect(appends(fake)).toEqual([]);
  });

  it("maps a rejected entity secret to entity_secret_rejected, keeping the credentials", async () => {
    const state = connected();
    const { fake, inScope } = database(state);
    const fakeCircle = circle({
      sets: [{ id: "set-treasury", name: TREASURY_WALLET_SET }],
      createWallets: () => Promise.reject(new UnauthorizedError({ ...REQUEST, status: 401, message: LEAKY })),
    });
    const error = await refusal(inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })));
    expect(error.code).toBe("entity_secret_rejected");
    expect(orgPatches(fake)).toEqual([]);
    expect(state.org.circle_api_key_enc).not.toBeNull();
    expect(appends(fake)).toEqual([]);
  });
});

describe("goLive", () => {
  it("sets mode to live only where it is still sandbox, and records workspace_went_live with ids only", async () => {
    const state = withWallets(connected());
    const { fake, inScope } = database(state);

    await inScope(() => goLive({ orgId: ORG, actorId: ACTOR }));

    const [update, ...others] = orgPatches(fake);
    expect(others).toEqual([]);
    expect(update.body).toEqual({ mode: "live" });
    expect(update.params.get("id")).toBe(`eq.${ORG}`);
    expect(update.params.get("mode")).toBe("eq.sandbox");
    expect(state.org.mode).toBe("live");
    expect(appends(fake).map((entry) => [entry.p_action, entry.p_detail])).toEqual([["workspace_went_live", { by: ACTOR }]]);
  });

  it("refuses without credentials", async () => {
    const state = sandbox();
    state.accounts = withWallets(sandbox()).accounts;
    const { fake, inScope } = database(state);
    expect((await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR })))).code).toBe("not_connected");
    expect(orgPatches(fake)).toEqual([]);
  });

  it("refuses when the operating account has no wallet", async () => {
    const state = connected();
    state.accounts[1] = { ...state.accounts[1], circle_wallet_id: "wallet-reserve", address: "0x" + "cd".repeat(20) };
    const { fake, inScope } = database(state);
    expect((await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR })))).code).toBe("no_wallets");
    expect(orgPatches(fake)).toEqual([]);
  });

  it("refuses the founding workspace, and cannot change its mode", async () => {
    const state = founding();
    const { fake, inScope } = database(state);
    expect((await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR })))).code).toBe("already_live");
    expect(orgPatches(fake)).toEqual([]);
    expect(appends(fake)).toEqual([]);
  });

  it("reports already_live when the conditional update matches no row (another owner won)", async () => {
    const { fake, inScope } = database(withWallets(connected()), { orgUpdateMatchesNothing: true });
    expect((await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR })))).code).toBe("already_live");
    expect(orgPatches(fake)).toHaveLength(1);
    expect(appends(fake)).toEqual([]);
  });
});

describe("goLiveStatus", () => {
  it("starts a new sandbox at connect", async () => {
    const { fake, inScope } = database(sandbox());
    await expect(inScope(() => goLiveStatus(ORG))).resolves.toEqual({
      step: "connect", connected: false, wallets: [], liveSince: null, credentialsUnreadable: false,
    });
    // Only whether credentials are stored is read, never the envelopes themselves.
    const statusRead = fake.requests.filter((request) => request.path === "/rest/v1/orgs" && request.params.get("select")?.includes("->>"));
    expect(statusRead).toHaveLength(1);
    const columns = statusRead[0].params.get("select")!.split(",");
    expect(columns).not.toContain("circle_api_key_enc");
    expect(columns).not.toContain("circle_entity_secret_enc");
  });

  it("moves to wallets once connected, and to go_live once every account has a wallet", async () => {
    await expect(database(connected()).inScope(() => goLiveStatus(ORG))).resolves.toMatchObject({ step: "wallets", connected: true, wallets: [] });

    const status = await database(withWallets(connected())).inScope(() => goLiveStatus(ORG));
    expect(status).toEqual({
      step: "go_live",
      connected: true,
      wallets: [
        { accountName: "Operating", kind: "operating", address: OPERATING_ADDRESS },
        { accountName: "Reserve", kind: "reserve", address: "0x" + "cd".repeat(20) },
      ],
      liveSince: null,
      credentialsUnreadable: false,
    });
    expect(JSON.stringify(status)).not.toContain("wallet-operating");
  });

  it("stays at wallets while an account still lacks one", async () => {
    const state = withWallets(connected());
    state.accounts[1] = { ...state.accounts[1], circle_wallet_id: null, address: null };
    await expect(database(state).inScope(() => goLiveStatus(ORG))).resolves.toMatchObject({
      step: "wallets",
      wallets: [{ accountName: "Operating", kind: "operating", address: OPERATING_ADDRESS }],
    });
  });

  it("shows a live workspace's live-since from its latest workspace_went_live entry", async () => {
    const state = withWallets(connected({ mode: "live" }));
    state.wentLive = [{ ts: "2026-09-30T08:00:00Z" }, { ts: "2026-09-30T09:00:00Z" }];
    const { fake, inScope } = database(state);
    await expect(inScope(() => goLiveStatus(ORG))).resolves.toMatchObject({ step: "live", liveSince: "2026-09-30T09:00:00Z" });
    const ledgerRead = fake.requests.find((request) => request.path === "/rest/v1/ledger_entries")!;
    expect(ledgerRead.params.get("action")).toBe("eq.workspace_went_live");
    expect(ledgerRead.params.get("order")).toBe("seq.desc");
    expect(ledgerRead.params.get("limit")).toBe("1");
  });

  it("shows the founding workspace as live with no live-since", async () => {
    await expect(database(founding()).inScope(() => goLiveStatus(ORG))).resolves.toEqual({
      step: "live",
      connected: true,
      wallets: [
        { accountName: "Operating", kind: "operating", address: OPERATING_ADDRESS },
        { accountName: "Reserve", kind: "reserve", address: "0x" + "cd".repeat(20) },
      ],
      liveSince: null,
      credentialsUnreadable: false,
    });
  });

  it("reports stored credentials this deployment cannot read", async () => {
    const state = connected({ circle_api_key_enc: seal(OLD_API_KEY, "circle_api_key_enc", OTHER_MASTER_KEYS) });
    await expect(database(state).inScope(() => goLiveStatus(ORG))).resolves.toMatchObject({ connected: true, credentialsUnreadable: true });
  });

  it("enters the organization's scope itself when called from outside one", async () => {
    await expect(database(founding()).unscoped(() => goLiveStatus(ORG))).resolves.toMatchObject({ step: "live" });
  });
});

describe("operatingBalance", () => {
  const liveProvider = (balance = 12.5) => ({
    mode: "live" as const,
    getBalance: vi.fn(async (accountId: string) => ({ accountId, chain: "ARC-TESTNET", token: "USDC", balance })),
  });

  it("reads the operating account's balance through a live provider, and returns only the number", async () => {
    const provider = liveProvider(12.5);
    await expect(database(withWallets(connected())).inScope(() => operatingBalance(provider))).resolves.toBe(12.5);
    expect(provider.getBalance).toHaveBeenCalledExactlyOnceWith("acct-operating");
  });

  it("refuses when the operating account has no wallet, without asking the provider", async () => {
    const provider = liveProvider();
    const error = await refusal(database(connected()).inScope(() => operatingBalance(provider)));
    expect(error.code).toBe("no_wallets");
    expect(provider.getBalance).not.toHaveBeenCalled();
  });

  it("refuses a simulated provider, whose balance is not the one on chain", async () => {
    const provider = { ...liveProvider(), mode: "simulate" as const };
    const error = await refusal(database(withWallets(connected())).inScope(() => operatingBalance(provider)));
    expect(error.code).toBe("not_connected");
    expect(provider.getBalance).not.toHaveBeenCalled();
  });
});
