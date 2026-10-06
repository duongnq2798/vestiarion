import crypto from "node:crypto";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InternalServerError,
  NotFoundError,
  RatelimitError,
  UnauthorizedError,
} from "@circle-fin/developer-controlled-wallets";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import type { CircleClient, CircleClientFactory } from "@/lib/circle/check";
import { TREASURY_WALLET_SET } from "@/lib/circle/provision";
import {
  chooseHostedWallet,
  connectCircle,
  createWallets,
  goLive,
  GoLiveError,
  goLiveStatus,
  operatingBalance,
} from "@/lib/platform/go-live";
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
const HOSTED_API_KEY = "TEST_API_KEY:hosted-key-id:hosted-key-secret-value";
const HOSTED_ENTITY_SECRET = "4057ed".repeat(10) + "beef";
const SECRETS = [API_KEY, ENTITY_SECRET, OLD_API_KEY, OLD_ENTITY_SECRET, HOSTED_API_KEY, HOSTED_ENTITY_SECRET];

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

/** A deployment with the platform's hosted Circle pair (hosted wallets H2). */
const hostedConfig = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
  HOSTED_CIRCLE_API_KEY: HOSTED_API_KEY,
  HOSTED_CIRCLE_ENTITY_SECRET: HOSTED_ENTITY_SECRET,
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
    wallet_host: "own" | "hosted" | null;
    /** Its network (0075); absent is Arc testnet. */
    network?: "arc-testnet" | "arc-mainnet";
  };
  accounts: AccountRow[];
  wentLive: Array<{ ts: string }>;
  sampleLoaded?: boolean;
}

const OPERATING_ADDRESS = "0x" + "ab".repeat(20);

function sandbox(overrides: Partial<State["org"]> = {}): State {
  return {
    org: {
      mode: "sandbox",
      ledger_signing_key_enc: seal(LEDGER_PEM, "ledger_signing_key_enc"),
      circle_api_key_enc: null,
      circle_entity_secret_enc: null,
      wallet_host: null,
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

/** A sandbox that chose the hosted testnet wallet: no credentials of its own. */
function hosted(overrides: Partial<State["org"]> = {}): State {
  return sandbox({ wallet_host: "hosted", ...overrides });
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

interface DatabaseOptions {
  orgUpdateMatchesNothing?: boolean;
  /** The platform configuration the scope is built from: `config` (no hosted pair) unless given. */
  platform?: VestiarionConfig;
  /** How many other workspaces are hosted already, for `choose_hosted_wallet`'s limit. */
  otherHosted?: number;
  /** Runs just before an update to the org row is applied: another owner's change, landing in between. */
  beforeOrgPatch?: () => void;
  /** `choose_hosted_wallet` fails with this message instead of running. */
  chooseError?: string;
  /** `choose_hosted_wallet` answers this instead of whether it changed the row (review minor 1). */
  chooseAnswer?: boolean;
  /** Runs right after go-live's own read of the org row (`orgState`), before anything reads it again. */
  afterStateRead?: () => void;
}

/** PostgREST's answer to a `raise exception` in a function. */
const raised = (message: string): FakeReply => ({ status: 400, body: { code: "P0001", message, details: null, hint: null } });

/** `choose_hosted_wallet` (0030), as the fake runs it: the same refusals, in the same order. */
function chooseHosted(state: State, body: { p_org_id: string; p_limit: number }, options: DatabaseOptions): FakeReply {
  if (options.chooseError) return raised(options.chooseError);
  if (body.p_org_id !== ORG) return raised(`org_not_found: no organization with id ${body.p_org_id}`);
  if (state.org.circle_api_key_enc || state.org.circle_entity_secret_enc || state.accounts.some((account) => account.circle_wallet_id)) {
    return raised("hosted_not_allowed: a workspace with Circle credentials or wallets cannot switch to a hosted wallet");
  }
  if (state.org.wallet_host === "hosted") return { body: options.chooseAnswer ?? false };
  if (body.p_limit === null || body.p_limit < 0 || (options.otherHosted ?? 0) >= body.p_limit) {
    return raised("hosted_limit_reached: every hosted testnet wallet is taken");
  }
  state.org.wallet_host = "hosted";
  return { body: options.chooseAnswer ?? true };
}

function database(state: State, options: DatabaseOptions = {}) {
  const platform = options.platform ?? config;
  const fake = fakeSupabase((request): FakeReply => {
    if (request.path === "/rest/v1/orgs" && request.method === "GET") {
      const select = request.params.get("select") ?? "*";
      const reply = one(request, [projectOrg(state, select)]);
      if (select.includes("api_key_stored")) options.afterStateRead?.();
      return reply;
    }
    if (request.path === "/rest/v1/orgs" && request.method === "PATCH") {
      options.beforeOrgPatch?.();
      const mode = eqValue(request, "mode");
      const host = request.params.get("wallet_host");
      if (options.orgUpdateMatchesNothing || eqValue(request, "id") !== ORG || (mode && mode !== state.org.mode)) return { body: [] };
      if (host && host !== (state.org.wallet_host === null ? "is.null" : `eq.${state.org.wallet_host}`)) return { body: [] };
      for (const [filter, value] of request.params) {
        const json = /^(\w+)->>(\w+)$/.exec(filter);
        if (!json) continue;
        const envelope = (state.org as Record<string, unknown>)[json[1]] as Record<string, unknown> | null;
        if (`eq.${envelope?.[json[2]] ?? ""}` !== value) return { body: [] };
      }
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
    if (request.path === "/rest/v1/counterparties" && request.method === "GET") {
      return { body: state.sampleLoaded ? [{ id: "cp-sample" }] : [] };
    }
    if (request.path === "/rest/v1/rpc/choose_hosted_wallet") {
      return chooseHosted(state, request.body as { p_org_id: string; p_limit: number }, options);
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
    inScope: <T>(fn: () => Promise<T>) =>
      runWith({ config: platform, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn, { userId: ACTOR })),
    /** Outside any organization's scope, as a script would call it. */
    unscoped: <T>(fn: () => Promise<T>) => runWith({ config: platform, db: fake.client, fetch: fake.fetch }, fn),
  };
}

function circle(options: {
  sets?: Array<{ id: string; name?: string }>;
  wallets?: Record<string, { id: string; walletSetId: string; address: string }>;
  walletSets?: Record<string, { id: string; name?: string }>;
  getWallet?: (id: string) => Promise<unknown>;
  getWalletSet?: (id: string) => Promise<unknown>;
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
  const getWalletSet = vi.fn(
    options.getWalletSet
      ? ({ id }: { id: string }) => options.getWalletSet!(id)
      : async ({ id }: { id: string }) => {
          const walletSet = options.walletSets?.[id];
          if (!walletSet) throw new NotFoundError({ ...REQUEST, status: 404, message: LEAKY });
          return { data: { walletSet } };
        }
  );
  const client = { listWalletSets, createWalletSet, createWallets, getWallet, getWalletSet } as unknown as CircleClient;
  const factory = vi.fn((given: { apiKey: string; entitySecret: string }) => {
    credentials.push(given);
    return client;
  }) as unknown as CircleClientFactory;
  return { factory, credentials, listWalletSets, createWalletSet, createWallets, getWallet, getWalletSet };
}

/** The same Circle entity as the one the fixtures' wallets were created in: its operating wallet, in its treasury set. */
const RESERVE_ADDRESS = "0x" + "cd".repeat(20);
const SAME_ENTITY = {
  sets: [{ id: "set-other", name: "something-else" }, { id: "set-treasury", name: TREASURY_WALLET_SET }],
  wallets: {
    "wallet-operating": { id: "wallet-operating", walletSetId: "set-treasury", address: OPERATING_ADDRESS.toUpperCase().replace("0X", "0x") },
    "wallet-reserve": { id: "wallet-reserve", walletSetId: "set-treasury", address: RESERVE_ADDRESS },
  },
  walletSets: { "set-other": { id: "set-other", name: "something-else" }, "set-treasury": { id: "set-treasury", name: TREASURY_WALLET_SET } },
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
    for (const secret of SECRETS) expect(line).not.toContain(secret);
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
  for (const secret of SECRETS) expect(text).not.toContain(secret);
  return outcome as GoLiveError;
}

describe("GoLiveError", () => {
  it.each([
    ["invalid", "Paste both the API key and the entity secret."],
    ["key_rejected", "Circle did not accept this API key."],
    ["unreachable", "Could not reach Circle; try again."],
    ["different_entity", "This workspace's wallets belong to the connected Circle account; use its credentials."],
    ["not_connected", "Connect Circle first."],
    ["entity_secret_rejected", "Circle did not accept the entity secret; reconnect with the right one."],
    ["no_wallets", "Create the treasury wallets first."],
    ["already_live", "This workspace is already live."],
    ["credentials_unreadable", "The stored Circle credentials cannot be read; reconnect."],
    ["credentials_changed", "The Circle credentials changed while going live; try again."],
    ["no_operating_wallet", "This workspace has no operating wallet; it cannot take new credentials."],
    ["hosted_unavailable", "Hosted testnet wallets are not available on this deployment."],
    ["hosted_not_allowed", "A workspace with its own Circle account or wallets cannot switch to a hosted wallet."],
    ["hosted_limit_reached", "All hosted testnet wallets are taken; connect your own Circle account instead."],
    [
      "hosted_has_wallets",
      "This workspace's wallets are hosted by Vestiarion; start a new workspace to use your own Circle account.",
    ],
  ] as const)("%s says %j", (code, message) => {
    const error = new GoLiveError(code);
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
  });
});

describe("connectCircle", () => {
  it("refuses while sample data is loaded, before asking Circle anything", async () => {
    const state = sandbox();
    state.sampleLoaded = true;
    const { fake, inScope } = database(state);
    const fakeCircle = circle();

    const error = await refusal(
      inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: fakeCircle.factory }))
    );

    expect(error.code).toBe("sample_data_loaded");
    expect(error.message).toBe("Remove the sample data first. It exists only to try the agent with simulated payments.");
    expect(fakeCircle.listWalletSets).not.toHaveBeenCalled();
    expect(orgPatches(fake)).toEqual([]);
    const [lookup] = fake.requests.filter((request) => request.path === "/rest/v1/counterparties");
    expect(lookup.params.get("sample")).toBe("eq.true");
  });

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
    const body = update.body as { circle_api_key_enc: SecretEnvelope; circle_entity_secret_enc: SecretEnvelope; wallet_host: string };
    // An own-account connect marks the workspace as its own, in the same update (H4).
    expect(Object.keys(body).sort()).toEqual(["circle_api_key_enc", "circle_entity_secret_enc", "wallet_host"]);
    expect(body.wallet_host).toBe("own");
    expect(state.org.wallet_host).toBe("own");

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

  it("refuses a Circle key for Arc mainnet on an Arc testnet workspace, before calling Circle or storing anything (network foundation N5)", async () => {
    const { fake, inScope } = database(sandbox());
    const fakeCircle = circle();
    const check = vi.fn();

    const error = await refusal(
      inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: "LIVE_API_KEY:live-key-id:live-key-secret", entitySecret: ENTITY_SECRET, check, client: fakeCircle.factory }))
    );

    expect(error.code).toBe("key_network");
    expect(error.message).toBe("This Circle API key is for Arc mainnet (LIVE_API_KEY). This workspace is on Arc testnet: paste a test key (TEST_API_KEY).");
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

  describe("once the operating account has a wallet, in any mode (Review Focus 5, R4)", () => {
    it.each([
      ["a live workspace", founding],
      ["a sandbox that already created its wallets", () => withWallets(connected())],
    ])("allows the same Circle entity on %s: the operating wallet reads back, at its address, in the treasury set", async (_label, make) => {
      const state = make();
      const mode = state.org.mode;
      const { fake, inScope } = database(state);
      const fakeCircle = circle(SAME_ENTITY);

      await inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: fakeCircle.factory }));

      // Every Circle call used the new credentials.
      for (const given of fakeCircle.credentials) expect(given).toEqual({ apiKey: API_KEY, entitySecret: ENTITY_SECRET });
      expect(fakeCircle.getWallet.mock.calls.map(([input]) => input)).toEqual([{ id: "wallet-operating" }, { id: "wallet-reserve" }]);
      expect(fakeCircle.getWalletSet).toHaveBeenCalledWith({ id: "set-treasury" });
      // The set is looked up by the wallet's own set id, not found in one page of a listing: the key check is the only listing.
      expect(fakeCircle.listWalletSets).toHaveBeenCalledTimes(1);
      expect(fakeCircle.createWalletSet).not.toHaveBeenCalled();
      expect(fakeCircle.createWallets).not.toHaveBeenCalled();
      const [update] = orgPatches(fake);
      expect(update.params.get("mode")).toBe(`eq.${mode}`);
      expect(state.org.mode).toBe(mode);
      expect(decryptSecret(state.org.circle_api_key_enc!, { orgId: ORG, column: "circle_api_key_enc" }, parseMasterKeys(MASTER_KEYS))).toBe(API_KEY);
      expect(appends(fake).map((entry) => [entry.p_action, entry.p_detail])).toEqual([["circle_reconnected", { by: ACTOR }]]);
    });

    it.each([
      ["the operating wallet is not found in the new entity", { ...SAME_ENTITY, wallets: {} }],
      ["the wallet's set is not found", { ...SAME_ENTITY, walletSets: {} }],
      [
        "the wallet's set is not the treasury set",
        { ...SAME_ENTITY, walletSets: { "set-treasury": { id: "set-treasury", name: "something-else" } } },
      ],
      [
        "the operating wallet is in another set",
        { ...SAME_ENTITY, wallets: { ...SAME_ENTITY.wallets, "wallet-operating": { id: "wallet-operating", walletSetId: "set-other", address: OPERATING_ADDRESS } } },
      ],
      [
        "the wallet's address is not the stored one",
        { ...SAME_ENTITY, wallets: { ...SAME_ENTITY.wallets, "wallet-operating": { id: "wallet-operating", walletSetId: "set-treasury", address: "0x" + "99".repeat(20) } } },
      ],
      [
        "the reserve's wallet is not found in the new entity",
        { ...SAME_ENTITY, wallets: { "wallet-operating": SAME_ENTITY.wallets["wallet-operating"] } },
      ],
      [
        "the reserve's wallet is in another set",
        { ...SAME_ENTITY, wallets: { ...SAME_ENTITY.wallets, "wallet-reserve": { id: "wallet-reserve", walletSetId: "set-other", address: RESERVE_ADDRESS } } },
      ],
      [
        "the reserve's wallet is at another address",
        { ...SAME_ENTITY, wallets: { ...SAME_ENTITY.wallets, "wallet-reserve": { id: "wallet-reserve", walletSetId: "set-treasury", address: "0x" + "77".repeat(20) } } },
      ],
      [
        "Circle refuses to read the wallet (401)",
        { ...SAME_ENTITY, getWallet: () => Promise.reject(new UnauthorizedError({ ...REQUEST, status: 401, message: LEAKY })) },
      ],
      [
        "Circle refuses to read the wallet set (401)",
        { ...SAME_ENTITY, getWalletSet: () => Promise.reject(new UnauthorizedError({ ...REQUEST, status: 401, message: LEAKY })) },
      ],
    ])("refuses a different entity when %s, storing nothing, live or sandbox", async (_label, entity) => {
      for (const make of [founding, () => withWallets(connected())]) {
        const state = make();
        const before = structuredClone(state.org);
        const { fake, inScope } = database(state);

        const error = await refusal(
          inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: circle(entity).factory }))
        );

        expect(error.code).toBe("different_entity");
        expect(error.message).toBe("This workspace's wallets belong to the connected Circle account; use its credentials.");
        expect(orgPatches(fake)).toEqual([]);
        expect(state.org).toEqual(before);
        expect(appends(fake)).toEqual([]);
      }
    });

    it("refuses a live workspace whose operating account has no wallet to prove the entity with", async () => {
      const state = connected({ mode: "live" });
      const { fake, inScope } = database(state);
      const fakeCircle = circle(SAME_ENTITY);
      const error = await refusal(
        inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: fakeCircle.factory }))
      );
      expect(error.code).toBe("no_operating_wallet");
      expect(error.message).toBe("This workspace has no operating wallet; it cannot take new credentials.");
      expect(fakeCircle.getWallet).not.toHaveBeenCalled();
      expect(orgPatches(fake)).toEqual([]);
    });

    it("refuses a live workspace with only a reserve wallet as having no operating wallet", async () => {
      const state = withWallets(connected({ mode: "live" }));
      state.accounts[0] = { ...state.accounts[0], circle_wallet_id: null, address: null };
      const { fake, inScope } = database(state);
      const error = await refusal(
        inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: circle(SAME_ENTITY).factory }))
      );
      expect(error.code).toBe("no_operating_wallet");
      expect(orgPatches(fake)).toEqual([]);
    });

    it("proves a sandbox with only a reserve wallet against that wallet", async () => {
      const state = withWallets(connected());
      state.accounts[0] = { ...state.accounts[0], circle_wallet_id: null, address: null };
      const { fake, inScope } = database(state);
      const fakeCircle = circle({ ...SAME_ENTITY, wallets: {} });
      const error = await refusal(
        inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: fakeCircle.factory }))
      );
      expect(error.code).toBe("different_entity");
      expect(fakeCircle.getWallet).toHaveBeenCalledWith({ id: "wallet-reserve" });
      expect(orgPatches(fake)).toEqual([]);
    });

    it.each([
      ["getWallet answers 500", { getWallet: () => Promise.reject(new InternalServerError({ ...REQUEST, status: 500, message: LEAKY })) }],
      ["getWallet answers 429", { getWallet: () => Promise.reject(new RatelimitError({ ...REQUEST, status: 429, message: LEAKY })) }],
      ["getWalletSet answers 500", { getWalletSet: () => Promise.reject(new InternalServerError({ ...REQUEST, status: 500, message: LEAKY })) }],
      ["getWalletSet answers 429", { getWalletSet: () => Promise.reject(new RatelimitError({ ...REQUEST, status: 429, message: LEAKY })) }],
      [
        "listWalletSets (the key check) answers 500",
        { listWalletSets: () => Promise.reject(new InternalServerError({ ...REQUEST, status: 500, message: LEAKY })) },
      ],
    ])("says unreachable, and stores nothing, when %s", async (_label, failure) => {
      const { fake, inScope } = database(withWallets(connected()));
      const fakeCircle = circle({ ...SAME_ENTITY, ...failure });
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

  it("is a no-op on the founding workspace, whose every account has a wallet: no Circle call, no write, no entry", async () => {
    const { fake, inScope } = database(founding());
    const fakeCircle = circle();
    await expect(inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory }))).resolves.toEqual({
      created: 0,
      skipped: 2,
    });
    expect(fakeCircle.factory).not.toHaveBeenCalled();
    expect(fake.requests.filter((request) => request.method === "PATCH")).toEqual([]);
    expect(appends(fake)).toEqual([]);
  });

  it("fills only the missing wallet on a live workspace (R6), under circle_wallet_id is null", async () => {
    const state = founding();
    state.accounts[1] = { ...state.accounts[1], name: "Reserve (simulated)", circle_wallet_id: null, address: null };
    const { fake, inScope } = database(state);
    const fakeCircle = circle({ sets: [{ id: "set-treasury", name: TREASURY_WALLET_SET }] });

    await expect(inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory }))).resolves.toEqual({
      created: 1,
      skipped: 1,
    });

    expect(fakeCircle.credentials).toEqual([{ apiKey: OLD_API_KEY, entitySecret: OLD_ENTITY_SECRET }]);
    const writes = fake.requests.filter((request) => request.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/rest/v1/accounts");
    expect(writes[0].params.get("id")).toBe("eq.acct-reserve");
    expect(writes[0].params.get("circle_wallet_id")).toBe("is.null");
    expect(state.accounts[0].circle_wallet_id).toBe("wallet-operating");
    expect(state.org.mode).toBe("live");
    expect(appends(fake).map((entry) => [entry.p_action, entry.p_detail])).toEqual([["treasury_wallets_created", { by: ACTOR, accounts: 1 }]]);
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

  it("says the stored credentials cannot be read, before any Circle call", async () => {
    const { fake, inScope } = database(connected({ circle_entity_secret_enc: seal(OLD_ENTITY_SECRET, "circle_entity_secret_enc", OTHER_MASTER_KEYS) }));
    const fakeCircle = circle();
    const error = await refusal(inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })));
    expect(error.code).toBe("credentials_unreadable");
    expect(error.message).toBe("The stored Circle credentials cannot be read; reconnect.");
    expect(fakeCircle.factory).not.toHaveBeenCalled();
    expect(fake.requests.filter((request) => request.method === "PATCH")).toEqual([]);
  });
});

describe("goLive", () => {
  it("re-proves the stored credentials, sets mode to live only where it is still sandbox, and records ids only", async () => {
    const state = withWallets(connected());
    const { fake, inScope } = database(state);
    const fakeCircle = circle(SAME_ENTITY);

    await inScope(() => goLive({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory }));

    // The proof ran with what is stored, not with anything the caller supplied, against every provisioned account.
    expect(fakeCircle.credentials).toEqual([{ apiKey: OLD_API_KEY, entitySecret: OLD_ENTITY_SECRET }]);
    expect(fakeCircle.getWallet.mock.calls.map(([input]) => input)).toEqual([{ id: "wallet-operating" }, { id: "wallet-reserve" }]);
    expect(fakeCircle.getWalletSet).toHaveBeenCalledWith({ id: "set-treasury" });
    const [update, ...others] = orgPatches(fake);
    expect(others).toEqual([]);
    expect(update.body).toEqual({ mode: "live" });
    expect(update.params.get("id")).toBe(`eq.${ORG}`);
    expect(update.params.get("mode")).toBe("eq.sandbox");
    // Bound to the envelope that was proven: its nonce, which every re-encryption changes.
    expect(update.params.get("circle_api_key_enc->>iv")).toBe(`eq.${state.org.circle_api_key_enc!.iv}`);
    expect(state.org.mode).toBe("live");
    expect(appends(fake).map((entry) => [entry.p_action, entry.p_detail])).toEqual([["workspace_went_live", { by: ACTOR, network: "arc-testnet" }]]);
  });

  it("proves with credentials replaced a moment earlier, even from a scope entered before they were", async () => {
    const state = withWallets(connected());
    const { fake, inScope } = database(state);
    const fakeCircle = circle(SAME_ENTITY);

    await inScope(async () => {
      await connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: fakeCircle.factory });
      await goLive({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory });
    });

    expect(fakeCircle.credentials.at(-1)).toEqual({ apiKey: API_KEY, entitySecret: ENTITY_SECRET });
    expect(state.org.mode).toBe("live");
    expect(appends(fake).map((entry) => entry.p_action)).toEqual(["circle_reconnected", "workspace_went_live"]);
  });

  it("answers credentials_changed when a connect lands between the proof and the update (Minor 3)", async () => {
    const state = withWallets(connected());
    const { fake, inScope } = database(state);
    const fakeCircle = circle({
      ...SAME_ENTITY,
      // The proof reads the set last; another owner's connect stores new credentials right then.
      getWalletSet: async (id: string) => {
        state.org.circle_api_key_enc = seal(API_KEY, "circle_api_key_enc");
        state.org.circle_entity_secret_enc = seal(ENTITY_SECRET, "circle_entity_secret_enc");
        return { data: { walletSet: SAME_ENTITY.walletSets[id as keyof typeof SAME_ENTITY.walletSets] } };
      },
    });

    const error = await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })));

    expect(error.code).toBe("credentials_changed");
    expect(error.message).toBe("The Circle credentials changed while going live; try again.");
    expect(orgPatches(fake)).toHaveLength(1);
    expect(state.org.mode).toBe("sandbox");
    expect(appends(fake)).toEqual([]);
  });

  it("refuses when a provisioned reserve wallet is not in the stored credentials' entity (Minor 4)", async () => {
    const state = withWallets(connected());
    const { fake, inScope } = database(state);
    const fakeCircle = circle({ ...SAME_ENTITY, wallets: { "wallet-operating": SAME_ENTITY.wallets["wallet-operating"] } });
    expect((await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })))).code).toBe("different_entity");
    expect(orgPatches(fake)).toEqual([]);
    expect(state.org.mode).toBe("sandbox");
  });

  it("refuses when the stored credentials open a different entity than the wallets' (R4)", async () => {
    const state = withWallets(connected());
    const { fake, inScope } = database(state);
    const fakeCircle = circle({ ...SAME_ENTITY, wallets: {} });

    const error = await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })));

    expect(error.code).toBe("different_entity");
    expect(orgPatches(fake)).toEqual([]);
    expect(state.org.mode).toBe("sandbox");
    expect(appends(fake)).toEqual([]);
  });

  it("says unreachable, and stays a sandbox, when Circle cannot answer the proof", async () => {
    const state = withWallets(connected());
    const { fake, inScope } = database(state);
    const fakeCircle = circle({ ...SAME_ENTITY, getWalletSet: () => Promise.reject(new RatelimitError({ ...REQUEST, status: 429, message: LEAKY })) });
    expect((await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })))).code).toBe("unreachable");
    expect(orgPatches(fake)).toEqual([]);
    expect(state.org.mode).toBe("sandbox");
  });

  it("refuses stored credentials this deployment cannot read, before any Circle call", async () => {
    const state = withWallets(connected({ circle_api_key_enc: seal(OLD_API_KEY, "circle_api_key_enc", OTHER_MASTER_KEYS) }));
    const { fake, inScope } = database(state);
    const fakeCircle = circle(SAME_ENTITY);
    const error = await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })));
    expect(error.code).toBe("credentials_unreadable");
    expect(fakeCircle.factory).not.toHaveBeenCalled();
    expect(orgPatches(fake)).toEqual([]);
  });

  it("refuses without credentials", async () => {
    const state = sandbox();
    state.accounts = withWallets(sandbox()).accounts;
    const { fake, inScope } = database(state);
    const fakeCircle = circle(SAME_ENTITY);
    expect((await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })))).code).toBe("not_connected");
    expect(fakeCircle.factory).not.toHaveBeenCalled();
    expect(orgPatches(fake)).toEqual([]);
  });

  it("refuses when the operating account has no wallet", async () => {
    const state = connected();
    state.accounts[1] = { ...state.accounts[1], circle_wallet_id: "wallet-reserve", address: "0x" + "cd".repeat(20) };
    const { fake, inScope } = database(state);
    const fakeCircle = circle(SAME_ENTITY);
    expect((await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })))).code).toBe("no_wallets");
    expect(fakeCircle.factory).not.toHaveBeenCalled();
    expect(orgPatches(fake)).toEqual([]);
  });

  it("refuses the founding workspace, and cannot change its mode", async () => {
    const state = founding();
    const { fake, inScope } = database(state);
    const fakeCircle = circle(SAME_ENTITY);
    expect((await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })))).code).toBe("already_live");
    expect(fakeCircle.factory).not.toHaveBeenCalled();
    expect(orgPatches(fake)).toEqual([]);
    expect(appends(fake)).toEqual([]);
  });

  it("reports already_live when another owner went live between the proof and the update", async () => {
    const state = withWallets(connected());
    const { fake, inScope } = database(state);
    const fakeCircle = circle({
      ...SAME_ENTITY,
      getWalletSet: async (id: string) => {
        state.org.mode = "live";
        return { data: { walletSet: SAME_ENTITY.walletSets[id as keyof typeof SAME_ENTITY.walletSets] } };
      },
    });
    expect((await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })))).code).toBe("already_live");
    expect(orgPatches(fake)).toHaveLength(1);
    expect(appends(fake)).toEqual([]);
  });
});

describe("goLiveStatus", () => {
  it("starts a new sandbox at connect", async () => {
    const { fake, inScope } = database(sandbox());
    await expect(inScope(() => goLiveStatus(ORG))).resolves.toEqual({
      step: "connect", connected: false, host: null, hostedAvailable: false, wallets: [], liveSince: null, credentialsUnreadable: false, network: "arc-testnet", mainnetOff: false,
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
      host: null,
      hostedAvailable: false,
      wallets: [
        { accountName: "Operating", kind: "operating", address: OPERATING_ADDRESS },
        { accountName: "Reserve", kind: "reserve", address: "0x" + "cd".repeat(20) },
      ],
      liveSince: null,
      credentialsUnreadable: false, network: "arc-testnet", mainnetOff: false,
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
      host: null,
      hostedAvailable: false,
      wallets: [
        { accountName: "Operating", kind: "operating", address: OPERATING_ADDRESS },
        { accountName: "Reserve", kind: "reserve", address: "0x" + "cd".repeat(20) },
      ],
      liveSince: null,
      credentialsUnreadable: false, network: "arc-testnet", mainnetOff: false,
    });
  });

  it("shows the founding workspace the same once 0030 marks it 'own', but for its host", async () => {
    const before = await database(founding()).inScope(() => goLiveStatus(ORG));
    const state = founding();
    state.org.wallet_host = "own";
    const after = await database(state).inScope(() => goLiveStatus(ORG));
    expect(after).toEqual({ ...before, host: "own" });
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

describe("hosted testnet wallets (hosted wallets H1, H3, H4)", () => {
  const HOSTED_SET = `vestiarion-${ORG}`;
  const rpcCalls = (fake: ReturnType<typeof fakeSupabase>) =>
    fake.requests.filter((request) => request.path === "/rest/v1/rpc/choose_hosted_wallet");

  describe("chooseHostedWallet", () => {
    it("refuses on a network without hosted wallets, by name, and never calls choose_hosted_wallet (network threading P5)", async () => {
      const state = sandbox({ network: "arc-mainnet" });
      const { fake, inScope } = database(state, { platform: hostedConfig });

      const error = await refusal(inScope(() => chooseHostedWallet({ orgId: ORG, actorId: ACTOR })));

      expect(error.code).toBe("hosted_network");
      expect(error.message).toBe("A hosted wallet does not run on Arc mainnet yet");
      expect(rpcCalls(fake)).toEqual([]);
      expect(state.org.wallet_host).toBeNull();
    });

    it("is not offered on such a network: the Go live panel leaves it out (network threading P5)", async () => {
      const { inScope } = database(sandbox({ network: "arc-mainnet" }), { platform: hostedConfig });
      await expect(inScope(() => goLiveStatus(ORG))).resolves.toMatchObject({ hostedAvailable: false });
      const testnet = database(sandbox(), { platform: hostedConfig });
      await expect(testnet.inScope(() => goLiveStatus(ORG))).resolves.toMatchObject({ hostedAvailable: true });
    });

    it("refuses while sample data is loaded, and never calls choose_hosted_wallet", async () => {
      const state = sandbox();
      state.sampleLoaded = true;
      const { fake, inScope } = database(state, { platform: hostedConfig });

      const error = await refusal(inScope(() => chooseHostedWallet({ orgId: ORG, actorId: ACTOR })));

      expect(error.code).toBe("sample_data_loaded");
      expect(rpcCalls(fake)).toEqual([]);
      expect(state.org.wallet_host).toBeNull();
    });

    it("marks a fresh sandbox hosted through choose_hosted_wallet with the platform limit, and records ids only", async () => {
      const state = sandbox();
      const { fake, inScope } = database(state, { platform: hostedConfig });

      await inScope(() => chooseHostedWallet({ orgId: ORG, actorId: ACTOR }));

      const [call, ...others] = rpcCalls(fake);
      expect(others).toEqual([]);
      expect(call.body).toEqual({ p_org_id: ORG, p_limit: 100 });
      expect(state.org.wallet_host).toBe("hosted");
      // The RPC is the only write: nothing else touches the org row.
      expect(orgPatches(fake)).toEqual([]);
      const entries = appends(fake);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ p_org_id: ORG, p_action: "hosted_wallet_chosen", p_domain: "system", p_actor: "human" });
      expect(entries[0].p_detail).toEqual({ by: ACTOR });
      const sent = JSON.stringify(fake.requests.map((request) => ({ params: request.params.toString(), body: request.body })));
      expect(sent).not.toContain(HOSTED_API_KEY);
      expect(sent).not.toContain(HOSTED_ENTITY_SECRET);
    });

    it("passes HOSTED_WORKSPACE_LIMIT through", async () => {
      const { fake, inScope } = database(sandbox(), { platform: { ...hostedConfig, hostedWorkspaceLimit: 3 } });
      await inScope(() => chooseHostedWallet({ orgId: ORG, actorId: ACTOR }));
      expect(rpcCalls(fake)[0].body).toEqual({ p_org_id: ORG, p_limit: 3 });
    });

    it("enters the organization's scope itself when called from outside one", async () => {
      const state = sandbox();
      const { fake, unscoped } = database(state, { platform: hostedConfig });
      await unscoped(() => chooseHostedWallet({ orgId: ORG, actorId: ACTOR }));
      expect(state.org.wallet_host).toBe("hosted");
      expect(appends(fake).map((entry) => entry.p_action)).toEqual(["hosted_wallet_chosen"]);
    });

    it.each([
      ["no pair at all", config],
      ["only the API key", { ...hostedConfig, chain: { ...hostedConfig.chain, hostedCircleEntitySecret: undefined } }],
      ["only the entity secret", { ...hostedConfig, chain: { ...hostedConfig.chain, hostedCircleApiKey: undefined } }],
    ])("refuses as hosted_unavailable on a deployment with %s, before the RPC", async (_label, platform) => {
      const state = sandbox();
      const { fake, inScope } = database(state, { platform });
      const error = await refusal(inScope(() => chooseHostedWallet({ orgId: ORG, actorId: ACTOR })));
      expect(error.code).toBe("hosted_unavailable");
      expect(error.message).toBe("Hosted testnet wallets are not available on this deployment.");
      expect(rpcCalls(fake)).toEqual([]);
      expect(state.org.wallet_host).toBeNull();
      expect(appends(fake)).toEqual([]);
    });

    // Review Focus 3: own to hosted once credentials or any wallet exist is refused.
    it.each([
      ["a workspace with its own credentials", () => connected()],
      ["an own-account workspace with credentials", () => connected({ wallet_host: "own" })],
      ["a workspace with wallets", () => withWallets(sandbox())],
      ["an own-account workspace with credentials and wallets", () => withWallets(connected({ wallet_host: "own" }))],
      ["a workspace with only a reserve wallet", () => {
        const state = withWallets(sandbox());
        state.accounts[0] = { ...state.accounts[0], circle_wallet_id: null, address: null };
        return state;
      }],
      ["a hosted workspace that already has wallets", () => withWallets(hosted())],
      ["the founding workspace", founding],
    ])("maps hosted_not_allowed for %s, and records nothing", async (_label, make) => {
      const state = make();
      const before = structuredClone(state.org);
      const { fake, inScope } = database(state, { platform: hostedConfig });
      const error = await refusal(inScope(() => chooseHostedWallet({ orgId: ORG, actorId: ACTOR })));
      expect(error.code).toBe("hosted_not_allowed");
      expect(error.message).toBe("A workspace with its own Circle account or wallets cannot switch to a hosted wallet.");
      expect(rpcCalls(fake)).toHaveLength(1);
      expect(state.org).toEqual(before);
      expect(appends(fake)).toEqual([]);
    });

    it("maps hosted_limit_reached, and records nothing", async () => {
      const state = sandbox();
      const { fake, inScope } = database(state, { platform: { ...hostedConfig, hostedWorkspaceLimit: 2 }, otherHosted: 2 });
      const error = await refusal(inScope(() => chooseHostedWallet({ orgId: ORG, actorId: ACTOR })));
      expect(error.code).toBe("hosted_limit_reached");
      expect(error.message).toBe("All hosted testnet wallets are taken; connect your own Circle account instead.");
      expect(state.org.wallet_host).toBeNull();
      expect(appends(fake)).toEqual([]);
    });

    it("admits the last place under the limit", async () => {
      const state = sandbox();
      const { inScope } = database(state, { platform: { ...hostedConfig, hostedWorkspaceLimit: 2 }, otherHosted: 1 });
      await inScope(() => chooseHostedWallet({ orgId: ORG, actorId: ACTOR }));
      expect(state.org.wallet_host).toBe("hosted");
    });

    it("is a no-op on a workspace already hosted with no wallets, and records nothing a second time", async () => {
      const state = hosted();
      const { fake, inScope } = database(state, { platform: hostedConfig });
      await inScope(() => chooseHostedWallet({ orgId: ORG, actorId: ACTOR }));
      expect(rpcCalls(fake)).toHaveLength(1);
      expect(state.org.wallet_host).toBe("hosted");
      expect(appends(fake)).toEqual([]);
    });

    it("records only when the function says it changed the row (review minor 1)", async () => {
      // Two owners choosing at once: the second call finds the workspace hosted and answers false.
      const quiet = database(sandbox(), { platform: hostedConfig, chooseAnswer: false });
      await quiet.inScope(() => chooseHostedWallet({ orgId: ORG, actorId: ACTOR }));
      expect(appends(quiet.fake)).toEqual([]);

      const loud = database(hosted(), { platform: hostedConfig, chooseAnswer: true });
      await loud.inScope(() => chooseHostedWallet({ orgId: ORG, actorId: ACTOR }));
      expect(appends(loud.fake).map((entry) => entry.p_action)).toEqual(["hosted_wallet_chosen"]);
    });

    it("reads nothing of the org row itself: the function's answer decides", async () => {
      const { fake, inScope } = database(sandbox(), { platform: hostedConfig });
      await inScope(() => chooseHostedWallet({ orgId: ORG, actorId: ACTOR }));
      const stateReads = fake.requests.filter(
        (request) => request.path === "/rest/v1/orgs" && request.params.get("select")?.includes("api_key_stored")
      );
      expect(stateReads).toEqual([]);
    });

    it("passes any other database failure on as a plain error, not a GoLiveError", async () => {
      const { fake, inScope } = database(sandbox(), { platform: hostedConfig, chooseError: "org_not_found: no organization" });
      const outcome = await inScope(() => chooseHostedWallet({ orgId: ORG, actorId: ACTOR })).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).not.toBeInstanceOf(GoLiveError);
      expect(appends(fake)).toEqual([]);
    });
  });

  describe("connectCircle on a hosted workspace (H4, Review Focus 3)", () => {
    it("switches a hosted workspace with no wallets to its own account, in the same update as the credentials", async () => {
      const state = hosted();
      const { fake, inScope } = database(state, { platform: hostedConfig });
      const fakeCircle = circle();

      await inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: fakeCircle.factory }));

      const [update, ...others] = orgPatches(fake);
      expect(others).toEqual([]);
      const body = update.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["circle_api_key_enc", "circle_entity_secret_enc", "wallet_host"]);
      expect(body.wallet_host).toBe("own");
      expect(state.org.wallet_host).toBe("own");
      // No wallets, so nothing to prove.
      expect(fakeCircle.getWallet).not.toHaveBeenCalled();
      expect(appends(fake).map((entry) => [entry.p_action, entry.p_detail])).toEqual([["circle_connected", { by: ACTOR }]]);

      // From here on the workspace pays with its own credentials, never the hosted pair.
      const status = await inScope(() => goLiveStatus(ORG));
      expect(status).toMatchObject({ step: "wallets", connected: true, host: "own" });
    });

    it.each([
      ["both wallets", () => withWallets(hosted())],
      ["only the reserve's", () => {
        const state = withWallets(hosted());
        state.accounts[0] = { ...state.accounts[0], circle_wallet_id: null, address: null };
        return state;
      }],
      ["a live hosted workspace's", () => withWallets(hosted({ mode: "live" }))],
    ])("refuses own credentials once the hosted workspace has %s, before any Circle call", async (_label, make) => {
      const state = make();
      const before = structuredClone(state.org);
      const { fake, inScope } = database(state, { platform: hostedConfig });
      const check = vi.fn(async () => "ok" as const);
      const fakeCircle = circle(SAME_ENTITY);

      const error = await refusal(
        inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, check, client: fakeCircle.factory }))
      );

      expect(error.code).toBe("hosted_has_wallets");
      expect(error.message).toBe("This workspace's wallets are hosted by Vestiarion; start a new workspace to use your own Circle account.");
      expect(check).not.toHaveBeenCalled();
      expect(fakeCircle.factory).not.toHaveBeenCalled();
      expect(orgPatches(fake)).toEqual([]);
      expect(state.org).toEqual(before);
      expect(appends(fake)).toEqual([]);
    });

    it("refuses when a wallet appears while the key is being checked, rather than proving own credentials against hosted wallets", async () => {
      const state = hosted();
      const { fake, inScope } = database(state, { platform: hostedConfig });
      const fakeCircle = circle(SAME_ENTITY);
      const check = vi.fn(async () => {
        withWallets(state);
        return "ok" as const;
      });

      const error = await refusal(
        inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, check, client: fakeCircle.factory }))
      );

      expect(error.code).toBe("hosted_has_wallets");
      expect(fakeCircle.getWallet).not.toHaveBeenCalled();
      expect(orgPatches(fake)).toEqual([]);
      expect(state.org.wallet_host).toBe("hosted");
    });

    it.each([
      ["not chosen", () => sandbox(), "is.null"],
      ["own", () => connected({ wallet_host: "own" }), "eq.own"],
      ["hosted", () => hosted(), "eq.hosted"],
    ] as const)("binds the credentials update to the wallet_host it read: %s (review minor 2)", async (_label, make, filter) => {
      const { fake, inScope } = database(make(), { platform: hostedConfig });
      await inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: circle().factory }));
      const [update] = orgPatches(fake);
      expect(update.params.get("wallet_host")).toBe(filter);
    });

    it("stores nothing when a hosted choice lands between the read and the write", async () => {
      const state = sandbox();
      const { fake, inScope } = database(state, { platform: hostedConfig });
      const check = vi.fn(async () => {
        // Another owner chooses the hosted wallet while this key is being checked.
        state.org.wallet_host = "hosted";
        return "ok" as const;
      });

      const outcome = await inScope(() =>
        connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, check })
      ).catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe("the workspace changed while Circle was being connected; nothing was stored");
      expect(orgPatches(fake)).toHaveLength(1);
      expect(state.org.wallet_host).toBe("hosted");
      expect(state.org.circle_api_key_enc).toBeNull();
      expect(appends(fake)).toEqual([]);
    });

    it("marks a workspace that had not chosen as its own", async () => {
      const state = sandbox();
      const { inScope } = database(state, { platform: hostedConfig });
      await inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: circle().factory }));
      expect(state.org.wallet_host).toBe("own");
    });

    it("still proves an own-account workspace's new credentials against its wallets, with the hosted pair configured", async () => {
      const state = withWallets(connected({ wallet_host: "own" }));
      const { inScope } = database(state, { platform: hostedConfig });
      const fakeCircle = circle(SAME_ENTITY);
      await inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: API_KEY, entitySecret: ENTITY_SECRET, client: fakeCircle.factory }));
      expect(fakeCircle.getWallet).toHaveBeenCalledTimes(2);
      expect(fakeCircle.getWalletSet).toHaveBeenCalledWith({ id: "set-treasury" });
      expect(state.org.wallet_host).toBe("own");
    });
  });

  describe("createWallets", () => {
    it("creates a hosted workspace's wallets with the hosted pair, in a set named for the workspace (Review Focus 4)", async () => {
      const state = hosted();
      const { fake, inScope } = database(state, { platform: hostedConfig });
      const fakeCircle = circle({ sets: [{ id: "set-treasury", name: TREASURY_WALLET_SET }] });

      const result = await inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory }));

      expect(result).toEqual({ created: 2, skipped: 0 });
      expect(fakeCircle.credentials).toEqual([{ apiKey: HOSTED_API_KEY, entitySecret: HOSTED_ENTITY_SECRET }]);
      expect(fakeCircle.createWalletSet).toHaveBeenCalledExactlyOnceWith({ name: HOSTED_SET });
      expect(fakeCircle.createWallets).toHaveBeenCalledTimes(2);
      for (const call of [1, 2]) expect(fakeCircle.createWallets).toHaveBeenNthCalledWith(call, expect.objectContaining({ walletSetId: "set-new" }));
      expect(state.accounts.map((account) => account.circle_wallet_id)).toEqual(["wallet-1", "wallet-2"]);
      expect(orgPatches(fake)).toEqual([]);
      expect(appends(fake).map((entry) => [entry.p_action, entry.p_detail])).toEqual([["treasury_wallets_created", { by: ACTOR, accounts: 2 }]]);
    });

    it("refuses a hosted workspace on a deployment without the pair, before any Circle call (H1)", async () => {
      const state = hosted();
      const { fake, inScope } = database(state);
      const fakeCircle = circle();
      const error = await refusal(inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })));
      expect(error.code).toBe("hosted_unavailable");
      expect(fakeCircle.factory).not.toHaveBeenCalled();
      expect(fake.requests.filter((request) => request.method === "PATCH")).toEqual([]);
    });

    it.each([
      ["not chosen", null],
      ["own", "own"],
    ] as const)("never creates wallets with the hosted pair for a workspace that is %s and has no credentials (Review Focus 1)", async (_label, host) => {
      const { inScope } = database(sandbox({ wallet_host: host }), { platform: hostedConfig });
      const fakeCircle = circle();
      const error = await refusal(inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })));
      expect(error.code).toBe("not_connected");
      expect(fakeCircle.factory).not.toHaveBeenCalled();
    });

    it("never creates wallets with the hosted pair for an own-account workspace whose credentials cannot be read (Review Focus 1)", async () => {
      const state = connected({ wallet_host: "own", circle_api_key_enc: seal(OLD_API_KEY, "circle_api_key_enc", OTHER_MASTER_KEYS) });
      const { inScope } = database(state, { platform: hostedConfig });
      const fakeCircle = circle();
      const error = await refusal(inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })));
      expect(error.code).toBe("credentials_unreadable");
      expect(fakeCircle.factory).not.toHaveBeenCalled();
    });

    it("answers credentials_changed when the workspace became hosted after the state was read (review minor 4)", async () => {
      const state = connected({ wallet_host: "own" });
      const { fake, inScope } = database(state, {
        platform: hostedConfig,
        afterStateRead: () => { state.org.wallet_host = "hosted"; },
      });
      const fakeCircle = circle();
      const error = await refusal(inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })));
      expect(error.code).toBe("credentials_changed");
      expect(fakeCircle.factory).not.toHaveBeenCalled();
      expect(fake.requests.filter((request) => request.method === "PATCH")).toEqual([]);
      expect(appends(fake)).toEqual([]);
    });

    it("uses an own-account workspace's own credentials and the treasury set, with the hosted pair configured", async () => {
      const { inScope } = database(connected({ wallet_host: "own" }), { platform: hostedConfig });
      const fakeCircle = circle({ sets: [{ id: "set-treasury", name: TREASURY_WALLET_SET }] });
      await inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory }));
      expect(fakeCircle.credentials).toEqual([{ apiKey: OLD_API_KEY, entitySecret: OLD_ENTITY_SECRET }]);
      expect(fakeCircle.createWalletSet).not.toHaveBeenCalled();
    });
  });

  describe("goLive", () => {
    it("takes a hosted workspace live without the same-entity proof, bound to wallet_host = 'hosted'", async () => {
      const state = withWallets(hosted());
      const { fake, inScope } = database(state, { platform: hostedConfig });
      const fakeCircle = circle(SAME_ENTITY);

      await inScope(() => goLive({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory }));

      // The entity is the platform's by construction: no Circle call at all.
      expect(fakeCircle.factory).not.toHaveBeenCalled();
      const [update, ...others] = orgPatches(fake);
      expect(others).toEqual([]);
      expect(update.body).toEqual({ mode: "live" });
      expect(update.params.get("id")).toBe(`eq.${ORG}`);
      expect(update.params.get("mode")).toBe("eq.sandbox");
      expect(update.params.get("wallet_host")).toBe("eq.hosted");
      expect(update.params.get("circle_api_key_enc->>iv")).toBeNull();
      expect(state.org.mode).toBe("live");
      expect(appends(fake).map((entry) => [entry.p_action, entry.p_detail])).toEqual([["workspace_went_live", { by: ACTOR, network: "arc-testnet" }]]);
    });

    it("refuses a hosted workspace whose operating account has no wallet", async () => {
      const state = hosted();
      state.accounts[1] = { ...state.accounts[1], circle_wallet_id: "wallet-reserve", address: RESERVE_ADDRESS };
      const { fake, inScope } = database(state, { platform: hostedConfig });
      expect((await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR })))).code).toBe("no_wallets");
      expect(orgPatches(fake)).toEqual([]);
    });

    it("refuses a hosted workspace on a deployment without the pair (H1, Review Focus 5)", async () => {
      const state = withWallets(hosted());
      const { fake, inScope } = database(state);
      const error = await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR })));
      expect(error.code).toBe("hosted_unavailable");
      expect(orgPatches(fake)).toEqual([]);
      expect(state.org.mode).toBe("sandbox");
    });

    it("answers credentials_changed when the workspace stops being hosted before the update", async () => {
      const state = withWallets(hosted());
      const { fake, inScope } = database(state, { platform: hostedConfig, beforeOrgPatch: () => { state.org.wallet_host = "own"; } });
      const error = await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR })));
      expect(error.code).toBe("credentials_changed");
      expect(orgPatches(fake)).toHaveLength(1);
      expect(state.org.mode).toBe("sandbox");
      expect(appends(fake)).toEqual([]);
    });

    it("answers already_live when another owner took the hosted workspace live first", async () => {
      const state = withWallets(hosted());
      const { fake, inScope } = database(state, { platform: hostedConfig, beforeOrgPatch: () => { state.org.mode = "live"; } });
      expect((await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR })))).code).toBe("already_live");
      expect(appends(fake)).toEqual([]);
    });

    it("answers credentials_changed when the workspace became hosted after the state was read, never going live unproven (review minor 4)", async () => {
      const state = withWallets(connected({ wallet_host: "own" }));
      const { fake, inScope } = database(state, {
        platform: hostedConfig,
        afterStateRead: () => { state.org.wallet_host = "hosted"; },
      });
      const fakeCircle = circle(SAME_ENTITY);
      const error = await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })));
      expect(error.code).toBe("credentials_changed");
      expect(fakeCircle.factory).not.toHaveBeenCalled();
      expect(orgPatches(fake)).toEqual([]);
      expect(state.org.mode).toBe("sandbox");
    });

    it("answers credentials_changed when a hosted workspace switched to its own account after the state was read", async () => {
      const state = withWallets(hosted());
      const { fake, inScope } = database(state, {
        platform: hostedConfig,
        afterStateRead: () => { state.org.wallet_host = "own"; },
      });
      const error = await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR })));
      expect(error.code).toBe("credentials_changed");
      expect(orgPatches(fake)).toEqual([]);
    });

    it("refuses a live hosted workspace", async () => {
      const { fake, inScope } = database(withWallets(hosted({ mode: "live" })), { platform: hostedConfig });
      expect((await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR })))).code).toBe("already_live");
      expect(orgPatches(fake)).toEqual([]);
    });

    it("still proves an own-account workspace, with the hosted pair configured: the proof is skipped for hosted only", async () => {
      const state = withWallets(connected({ wallet_host: "own" }));
      const { fake, inScope } = database(state, { platform: hostedConfig });
      const fakeCircle = circle({ ...SAME_ENTITY, wallets: {} });
      expect((await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR, client: fakeCircle.factory })))).code).toBe("different_entity");
      expect(fakeCircle.credentials).toEqual([{ apiKey: OLD_API_KEY, entitySecret: OLD_ENTITY_SECRET }]);
      expect(orgPatches(fake)).toEqual([]);
    });

    it("binds an own-account workspace's update to the envelope, not to wallet_host", async () => {
      const state = withWallets(connected({ wallet_host: "own" }));
      const { fake, inScope } = database(state, { platform: hostedConfig });
      await inScope(() => goLive({ orgId: ORG, actorId: ACTOR, client: circle(SAME_ENTITY).factory }));
      const [update] = orgPatches(fake);
      expect(update.params.get("circle_api_key_enc->>iv")).toBe(`eq.${state.org.circle_api_key_enc!.iv}`);
      expect(update.params.get("wallet_host")).toBeNull();
      expect(state.org.mode).toBe("live");
    });

    it("refuses an own-account workspace with no credentials, never going live on the hosted pair (Review Focus 1)", async () => {
      const state = withWallets(sandbox({ wallet_host: "own" }));
      const { fake, inScope } = database(state, { platform: hostedConfig });
      expect((await refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR })))).code).toBe("not_connected");
      expect(orgPatches(fake)).toEqual([]);
    });
  });

  describe("goLiveStatus", () => {
    it("offers the choice to a fresh sandbox on a deployment with the pair", async () => {
      await expect(database(sandbox(), { platform: hostedConfig }).inScope(() => goLiveStatus(ORG))).resolves.toEqual({
        step: "connect", connected: false, host: null, hostedAvailable: true, wallets: [], liveSince: null, credentialsUnreadable: false, network: "arc-testnet", mainnetOff: false,
      });
    });

    it("puts a hosted workspace with no wallets at wallets: the choice was its connect step", async () => {
      await expect(database(hosted(), { platform: hostedConfig }).inScope(() => goLiveStatus(ORG))).resolves.toEqual({
        step: "wallets", connected: false, host: "hosted", hostedAvailable: true, wallets: [], liveSince: null, credentialsUnreadable: false, network: "arc-testnet", mainnetOff: false,
      });
    });

    it("moves a hosted workspace to go_live once every account has a wallet, and to live", async () => {
      await expect(database(withWallets(hosted()), { platform: hostedConfig }).inScope(() => goLiveStatus(ORG))).resolves.toMatchObject({
        step: "go_live", host: "hosted",
      });
      await expect(
        database(withWallets(hosted({ mode: "live" })), { platform: hostedConfig }).inScope(() => goLiveStatus(ORG))
      ).resolves.toMatchObject({ step: "live", host: "hosted" });
    });

    it("says an own-account workspace is own", async () => {
      await expect(database(connected({ wallet_host: "own" }), { platform: hostedConfig }).inScope(() => goLiveStatus(ORG))).resolves.toMatchObject({
        step: "wallets", connected: true, host: "own", hostedAvailable: true,
      });
    });

    it("reports a hosted workspace on a deployment without the pair as unreadable, and the choice as unavailable (Review Focus 5)", async () => {
      await expect(database(withWallets(hosted())).inScope(() => goLiveStatus(ORG))).resolves.toMatchObject({
        host: "hosted", hostedAvailable: false, credentialsUnreadable: true,
      });
    });

    it("carries nothing of the hosted pair", async () => {
      for (const state of [sandbox(), hosted(), withWallets(hosted())]) {
        const status = await database(state, { platform: hostedConfig }).inScope(() => goLiveStatus(ORG));
        expect(JSON.stringify(status)).not.toContain(HOSTED_API_KEY);
        expect(JSON.stringify(status)).not.toContain(HOSTED_ENTITY_SECRET);
        expect(typeof status.hostedAvailable).toBe("boolean");
      }
    });
  });
});

describe("Arc mainnet (mainnet go-live M8)", () => {
  const OWNER = "owner@acme.test";
  const LIVE_KEY = "LIVE_API_KEY:main-key-id:main-key-secret-value";
  const mainnetPlatform: VestiarionConfig = { ...config, mainnetEnabled: true, mainnetAllowlist: [OWNER] };
  /** The workspace on Arc mainnet: its one operating account on ARC, as createWorkspace makes it (M2). */
  const onMainnet = (state: State): State => {
    state.org.network = "arc-mainnet";
    state.accounts = state.accounts.filter((account) => account.kind === "operating").map((account) => ({ ...account, name: "Operating", chain: "ARC" }));
    return state;
  };
  const okKey = async () => "ok" as const;

  it("refuses someone not on the allowlist at every step, before Circle is asked", async () => {
    for (const email of ["other@acme.test", null, undefined]) {
      const { inScope } = database(onMainnet(sandbox()), { platform: mainnetPlatform });
      const c = circle();
      const connect = await refusal(inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, actorEmail: email, apiKey: LIVE_KEY, entitySecret: ENTITY_SECRET, client: c.factory, check: okKey })));
      expect(connect).toMatchObject({ code: "mainnet_not_open", message: "Arc mainnet is not open to this account yet." });
      const wallets = database(onMainnet(connected({ circle_api_key_enc: seal(LIVE_KEY, "circle_api_key_enc") })), { platform: mainnetPlatform });
      await expect(refusal(wallets.inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, actorEmail: email, client: c.factory })))).resolves.toMatchObject({ code: "mainnet_not_open" });
      expect(c.factory).not.toHaveBeenCalled();
    }
  });

  it("refuses everyone while the deployment has Arc mainnet off", async () => {
    const { inScope } = database(onMainnet(sandbox()), { platform: { ...mainnetPlatform, mainnetEnabled: false } });
    await expect(
      refusal(inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER, apiKey: LIVE_KEY, entitySecret: ENTITY_SECRET, check: okKey })))
    ).resolves.toMatchObject({ code: "mainnet_not_open" });
  });

  it("refuses a test key on a mainnet workspace, naming both networks, as a live key is refused on a testnet one", async () => {
    const { inScope } = database(onMainnet(sandbox()), { platform: mainnetPlatform });
    const error = await refusal(inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER, apiKey: API_KEY, entitySecret: ENTITY_SECRET, check: okKey })));
    expect(error.code).toBe("key_network");
    expect(error.message).toBe("This Circle API key is for Arc testnet (TEST_API_KEY). This workspace is on Arc mainnet: paste a live key (LIVE_API_KEY).");
    const testnet = database(sandbox(), { platform: mainnetPlatform });
    const live = await refusal(testnet.inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, apiKey: LIVE_KEY, entitySecret: ENTITY_SECRET, check: okKey })));
    expect(live.message).toBe("This Circle API key is for Arc mainnet (LIVE_API_KEY). This workspace is on Arc testnet: paste a test key (TEST_API_KEY).");
  });

  it("connects a live key and creates one EOA on ARC: the dry run, with nothing sent", async () => {
    const state = onMainnet(sandbox());
    const { inScope } = database(state, { platform: mainnetPlatform });
    const c = circle({ sets: [{ id: "set-treasury", name: TREASURY_WALLET_SET }] });
    await inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER, apiKey: LIVE_KEY, entitySecret: ENTITY_SECRET, client: c.factory, check: okKey }));
    expect(await inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER, client: c.factory }))).toEqual({ created: 1, skipped: 0 });
    expect(c.createWallets).toHaveBeenCalledTimes(1);
    expect((c.createWallets.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0]).toMatchObject({ blockchains: ["ARC"], accountType: "EOA" });
    expect(state.org.mode).toBe("sandbox");
  });

  it("goes live only with the word typed, and records the network", async () => {
    const state = onMainnet(withWallets(connected({ circle_api_key_enc: seal(LIVE_KEY, "circle_api_key_enc") })));
    const { fake, inScope } = database(state, { platform: mainnetPlatform });
    const c = circle(SAME_ENTITY);
    for (const word of [undefined, "", "main net", "testnet", "mainnet!"]) {
      await expect(refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER, confirmation: word, client: c.factory })))).resolves.toMatchObject({
        code: "mainnet_confirmation",
        message: "Type mainnet to confirm that this workspace pays real USDC.",
      });
    }
    expect(state.org.mode).toBe("sandbox");
    expect(orgPatches(fake)).toEqual([]);

    await inScope(() => goLive({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER, confirmation: "  Mainnet ", client: c.factory }));
    expect(state.org.mode).toBe("live");
    expect(appends(fake).map((entry) => [entry.p_action, entry.p_detail])).toEqual([["workspace_went_live", { by: ACTOR, network: "arc-mainnet" }]]);
  });

  it("does not take the word from someone not on the allowlist", async () => {
    const state = onMainnet(withWallets(connected({ circle_api_key_enc: seal(LIVE_KEY, "circle_api_key_enc") })));
    const { inScope } = database(state, { platform: mainnetPlatform });
    await expect(refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR, actorEmail: "other@acme.test", confirmation: "mainnet", client: circle(SAME_ENTITY).factory })))).resolves.toMatchObject({
      code: "mainnet_not_open",
    });
    expect(state.org.mode).toBe("sandbox");
  });

  it("reports the network, and Arc mainnet switched off rather than credentials it cannot read", async () => {
    const off = database(onMainnet(connected({ circle_api_key_enc: seal(LIVE_KEY, "circle_api_key_enc") })), { platform: config });
    await expect(off.inScope(() => goLiveStatus(ORG))).resolves.toMatchObject({ network: "arc-mainnet", mainnetOff: true, credentialsUnreadable: false });
    const fresh = database(onMainnet(sandbox()), { platform: mainnetPlatform });
    await expect(fresh.inScope(() => goLiveStatus(ORG))).resolves.toMatchObject({ network: "arc-mainnet", mainnetOff: false, credentialsUnreadable: false, step: "connect" });
    const testnet = database(sandbox(), { platform: mainnetPlatform });
    await expect(testnet.inScope(() => goLiveStatus(ORG))).resolves.toMatchObject({ network: "arc-testnet", mainnetOff: false });
  });
});
