import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BadRequestError,
  ForbiddenError,
  InternalServerError,
  UnauthorizedError,
} from "@circle-fin/developer-controlled-wallets";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { CircleClient, CircleClientFactory } from "@/lib/circle/check";
import {
  createTreasuryWallets,
  EntitySecretRejected,
  TREASURY_WALLET_SET,
  treasuryWalletSetId,
  walletIdempotencyKey,
  walletSetName,
} from "@/lib/circle/provision";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Treasury-wallet provisioning, run the way an owner's "Create wallets" runs
 * it: inside the organization's scope, with the Circle credentials that scope
 * decrypted, over a recorded Supabase and a fake Circle client that throws the
 * SDK's own error classes.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c1c";
const API_KEY = "TEST_API_KEY:provision-key-id:provision-key-secret-value";
const ENTITY_SECRET = "5eed".repeat(16);
const REQUEST = { url: "/v1/w3s/developer/wallets", method: "POST" };
const LEAKY = `Bearer ${API_KEY} ${ENTITY_SECRET}`;

const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const config: VestiarionConfig = { ...base, chain: { ...base.chain, circleApiKey: API_KEY, circleEntitySecret: ENTITY_SECRET } };

interface AccountRow {
  id: string;
  name: string;
  chain: string;
  circle_wallet_id: string | null;
}

const OPERATING: AccountRow = { id: "acct-operating", name: "Operating (simulated)", chain: "ARC-TESTNET", circle_wallet_id: null };
const RESERVE: AccountRow = { id: "acct-reserve", name: "Reserve (simulated)", chain: "ARC-TESTNET", circle_wallet_id: null };
const PROVISIONED: AccountRow = { id: "acct-done", name: "Payroll", chain: "ARC-TESTNET", circle_wallet_id: "wallet-existing" };

const logged: string[] = [];

function database(accounts: AccountRow[], options: { lostRace?: string[] } = {}) {
  return fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.method === "GET" && request.path === "/rest/v1/accounts") return { body: accounts };
    if (request.method === "PATCH" && request.path === "/rest/v1/accounts") {
      const id = request.params.get("id")?.replace(/^eq\./, "");
      return { body: options.lostRace?.includes(id ?? "") ? [] : [{ id }] };
    }
    throw new Error(`unexpected request ${request.method} ${request.path}`);
  });
}

function circle(options: {
  sets?: Array<{ id: string; name?: string }>;
  createWallets?: (input: { blockchains: string[] }, call: number) => Promise<unknown>;
  createWalletSet?: () => Promise<unknown>;
} = {}) {
  let walletCalls = 0;
  const listWalletSets = vi.fn(async () => ({ data: { walletSets: options.sets ?? [] } }));
  const createWalletSet = vi.fn(
    options.createWalletSet ?? (async ({ name }: { name: string }) => ({ data: { walletSet: { id: "set-new", name } } }))
  );
  const createWallets = vi.fn(async (input: { blockchains: string[] }) => {
    walletCalls += 1;
    if (options.createWallets) return options.createWallets(input, walletCalls);
    return { data: { wallets: [{ id: `wallet-${walletCalls}`, address: `0x${String(walletCalls).padStart(40, "0")}` }] } };
  });
  const client = { listWalletSets, createWalletSet, createWallets } as unknown as CircleClient;
  const factory = vi.fn(() => client) as unknown as CircleClientFactory & ReturnType<typeof vi.fn>;
  return { factory, listWalletSets, createWalletSet, createWallets };
}

function inOrg<T>(fake: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>, chainConfig = config): Promise<T> {
  return runWith(orgTestContext({ config: chainConfig, client: fake.client, orgId: ORG }), fn);
}

const patches = (fake: ReturnType<typeof fakeSupabase>) =>
  fake.requests.filter((request) => request.method === "PATCH");

beforeEach(() => {
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 5 }))).join(" "));
    });
  }
});

afterEach(() => {
  for (const line of logged) {
    expect(line).not.toContain(API_KEY);
    expect(line).not.toContain(ENTITY_SECRET);
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createTreasuryWallets", () => {
  it("builds its Circle client from the organization's own credentials", async () => {
    const fake = database([OPERATING]);
    const fakeCircle = circle();
    await inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory }));
    expect(fakeCircle.factory).toHaveBeenCalledWith({ apiKey: API_KEY, entitySecret: ENTITY_SECRET });
  });

  it("creates one SCA wallet per unprovisioned account, skips provisioned ones, and drops \"(simulated)\"", async () => {
    const fake = database([OPERATING, PROVISIONED, RESERVE]);
    const fakeCircle = circle({ sets: [{ id: "set-other", name: "something-else" }, { id: "set-treasury", name: TREASURY_WALLET_SET }] });

    const result = await inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory }));

    expect(result).toEqual({ created: 2, skipped: 1 });
    expect(fakeCircle.createWalletSet).not.toHaveBeenCalled();
    expect(fakeCircle.createWallets).toHaveBeenCalledTimes(2);
    for (const [index, [input]] of fakeCircle.createWallets.mock.calls.entries()) {
      expect(input).toMatchObject({ blockchains: ["ARC-TESTNET"], count: 1, walletSetId: "set-treasury", accountType: "SCA" });
      // Deterministic per (organization, account): a retried or concurrent run gets the same wallet back from Circle.
      expect(input).toMatchObject({ idempotencyKey: walletIdempotencyKey(ORG, [OPERATING, RESERVE][index].id) });
    }

    const writes = patches(fake);
    expect(writes).toHaveLength(2);
    // A new wallet holds nothing yet: the simulated balance is zeroed, so it never funds a live payment
    // or a notional reserve. The already-provisioned account is not written at all, balance included.
    expect(writes[0].body).toEqual({ circle_wallet_id: "wallet-1", address: `0x${"1".padStart(40, "0")}`, name: "Operating", balance: 0 });
    expect(writes[1].body).toEqual({ circle_wallet_id: "wallet-2", address: `0x${"2".padStart(40, "0")}`, name: "Reserve", balance: 0 });
    expect(writes.map((write) => write.params.get("id"))).not.toContain(`eq.${PROVISIONED.id}`);
    for (const [index, write] of writes.entries()) {
      expect(write.params.get("id")).toBe(`eq.${[OPERATING, RESERVE][index].id}`);
      expect(write.params.get("org_id")).toBe(`eq.${ORG}`);
      // The write is conditional: a second "Create wallets" cannot overwrite the first's wallet.
      expect(write.params.get("circle_wallet_id")).toBe("is.null");
    }
  });

  it("creates the wallet set when the entity has none by that name", async () => {
    const fake = database([OPERATING]);
    const fakeCircle = circle({ sets: [{ id: "set-other", name: "something-else" }] });

    await inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory }));

    expect(fakeCircle.createWalletSet).toHaveBeenCalledWith({ name: TREASURY_WALLET_SET });
    expect(fakeCircle.createWallets.mock.calls[0][0]).toMatchObject({ walletSetId: "set-new" });
  });

  it("makes no Circle write when every account is provisioned", async () => {
    const fake = database([PROVISIONED]);
    const fakeCircle = circle();
    await expect(inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory }))).resolves.toEqual({ created: 0, skipped: 1 });
    expect(fakeCircle.createWalletSet).not.toHaveBeenCalled();
    expect(fakeCircle.createWallets).not.toHaveBeenCalled();
    expect(patches(fake)).toEqual([]);
  });

  it("leaves an account another run provisioned first alone, without throwing", async () => {
    const fake = database([OPERATING, RESERVE], { lostRace: [OPERATING.id] });
    const fakeCircle = circle({ sets: [{ id: "set-treasury", name: TREASURY_WALLET_SET }] });

    const result = await inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory }));

    expect(result).toEqual({ created: 1, skipped: 1 });
    expect(patches(fake)).toHaveLength(2);
  });

  it.each([
    ["a 401", () => new UnauthorizedError({ ...REQUEST, status: 401, message: LEAKY })],
    ["a 403", () => new ForbiddenError({ ...REQUEST, status: 403, code: 156016, message: LEAKY })],
    ["Circle's invalid-entity-secret code on a 400", () => new BadRequestError({ ...REQUEST, status: 400, code: 156013, message: LEAKY })],
  ])("throws EntitySecretRejected on %s from createWallets, keeping the wallets already written", async (_label, error) => {
    const fake = database([OPERATING, RESERVE]);
    const fakeCircle = circle({
      sets: [{ id: "set-treasury", name: TREASURY_WALLET_SET }],
      createWallets: async (_input, call) => {
        if (call === 2) throw error();
        return { data: { wallets: [{ id: "wallet-1", address: "0xaaaa" }] } };
      },
    });

    const outcome = await inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory })).catch((e: unknown) => e);

    expect(outcome).toBeInstanceOf(EntitySecretRejected);
    expect((outcome as Error).message).not.toContain(API_KEY);
    expect((outcome as Error).message).not.toContain(ENTITY_SECRET);
    // The operating account's wallet was written before the rejection, and stays.
    expect(patches(fake)).toHaveLength(1);
    expect(patches(fake)[0].body).toMatchObject({ circle_wallet_id: "wallet-1" });
  });

  it("throws EntitySecretRejected when creating the wallet set is refused", async () => {
    const fake = database([OPERATING]);
    const fakeCircle = circle({ createWalletSet: () => Promise.reject(new UnauthorizedError({ ...REQUEST, status: 401, message: LEAKY })) });
    await expect(inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory }))).rejects.toBeInstanceOf(EntitySecretRejected);
    expect(fakeCircle.createWallets).not.toHaveBeenCalled();
  });

  it("throws EntitySecretRejected when the SDK cannot even encrypt a malformed secret", async () => {
    const fake = database([OPERATING]);
    const fakeCircle = circle({
      sets: [{ id: "set-treasury", name: TREASURY_WALLET_SET }],
      createWallets: () => Promise.reject(new Error("hexToBytes: input must be valid hex")),
    });
    await expect(inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory }))).rejects.toBeInstanceOf(EntitySecretRejected);
  });

  it("does not take a server error for a rejected secret, and never passes on the SDK's message", async () => {
    const fake = database([OPERATING]);
    const fakeCircle = circle({
      sets: [{ id: "set-treasury", name: TREASURY_WALLET_SET }],
      createWallets: () => Promise.reject(new InternalServerError({ ...REQUEST, status: 500, message: LEAKY })),
    });

    const outcome = await inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory })).catch((e: unknown) => e);

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(EntitySecretRejected);
    expect(inspect(outcome, { depth: 5 })).not.toContain(API_KEY);
    expect(inspect(outcome, { depth: 5 })).not.toContain(ENTITY_SECRET);
    expect(patches(fake)).toEqual([]);
  });

  it("gives up on a wallet call Circle does not answer within 15 s, and not before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = database([OPERATING]);
    const fakeCircle = circle({
      sets: [{ id: "set-treasury", name: TREASURY_WALLET_SET }],
      createWallets: () => new Promise<never>(() => {}),
    });
    let outcome: unknown;
    const pending = inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory })).then(
      (value) => (outcome = value),
      (error: unknown) => (outcome = error)
    );

    await vi.advanceTimersByTimeAsync(14_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(EntitySecretRejected);
    expect(patches(fake)).toEqual([]);
  });

  it("refuses before any Circle call when the credentials are missing or unreadable", async () => {
    for (const chain of [
      { ...config.chain, circleEntitySecret: undefined },
      { ...config.chain, circleApiKey: undefined },
      { ...config.chain, credentialsUnreadable: "circle_entity_secret_enc could not be decrypted" },
    ]) {
      const fake = database([OPERATING]);
      const fakeCircle = circle();
      await expect(inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory }), { ...config, chain })).rejects.toThrow();
      expect(fakeCircle.factory).not.toHaveBeenCalled();
      expect(fake.requests).toEqual([]);
    }
  });
});

describe("the wallet set per host (hosted wallets H3, Review Focus 4)", () => {
  const OTHER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c1d";
  const HOSTED_SET = `vestiarion-${ORG}`;
  const hostedConfig: VestiarionConfig = { ...config, chain: { ...config.chain, walletHost: "hosted" } };

  it("names the set vestiarion-<orgId> for a hosted workspace, and vestiarion-treasury otherwise", () => {
    expect(walletSetName(ORG, "hosted")).toBe(HOSTED_SET);
    expect(walletSetName(ORG, "own")).toBe(TREASURY_WALLET_SET);
    expect(walletSetName(ORG, null)).toBe(TREASURY_WALLET_SET);
    expect(walletSetName(ORG, undefined)).toBe(TREASURY_WALLET_SET);
    expect(walletSetName(OTHER_ORG, "hosted")).not.toBe(HOSTED_SET);
  });

  it("hosted: creates the workspace's own set in the shared entity, never the shared treasury set or another workspace's", async () => {
    const fake = database([OPERATING, RESERVE]);
    const fakeCircle = circle({
      sets: [
        { id: "set-treasury", name: TREASURY_WALLET_SET },
        { id: "set-neighbour", name: `vestiarion-${OTHER_ORG}` },
      ],
    });

    const result = await inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory }), hostedConfig);

    expect(result).toEqual({ created: 2, skipped: 0 });
    expect(fakeCircle.createWalletSet).toHaveBeenCalledExactlyOnceWith({ name: HOSTED_SET });
    for (const [index, [input]] of fakeCircle.createWallets.mock.calls.entries()) {
      expect(input).toMatchObject({ walletSetId: "set-new", accountType: "SCA" });
      // The idempotency key does not change with the host.
      expect(input).toMatchObject({ idempotencyKey: walletIdempotencyKey(ORG, [OPERATING, RESERVE][index].id) });
    }
  });

  it("hosted: reuses the workspace's own set once it exists", async () => {
    const fake = database([OPERATING]);
    const fakeCircle = circle({
      sets: [
        { id: "set-treasury", name: TREASURY_WALLET_SET },
        { id: "set-mine", name: HOSTED_SET },
      ],
    });
    await inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory }), hostedConfig);
    expect(fakeCircle.createWalletSet).not.toHaveBeenCalled();
    expect(fakeCircle.createWallets.mock.calls[0][0]).toMatchObject({ walletSetId: "set-mine" });
  });

  it.each([
    ["own", "own"],
    ["not chosen", null],
    ["not said at all", undefined],
  ] as const)("%s: uses the treasury set, as before", async (_label, walletHost) => {
    const fake = database([OPERATING]);
    const fakeCircle = circle({ sets: [{ id: "set-mine", name: HOSTED_SET }, { id: "set-treasury", name: TREASURY_WALLET_SET }] });
    await inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory }), { ...config, chain: { ...config.chain, walletHost } });
    expect(fakeCircle.createWalletSet).not.toHaveBeenCalled();
    expect(fakeCircle.createWallets.mock.calls[0][0]).toMatchObject({ walletSetId: "set-treasury" });
  });

  it("treasuryWalletSetId, which the bootstrap script also uses, names the set from the scope", async () => {
    const fakeCircle = circle({ sets: [{ id: "set-treasury", name: TREASURY_WALLET_SET }] });
    const client = fakeCircle.factory({ apiKey: API_KEY, entitySecret: ENTITY_SECRET });
    const fake = database([]);
    await expect(inOrg(fake, () => treasuryWalletSetId(client))).resolves.toBe("set-treasury");
    await expect(inOrg(fake, () => treasuryWalletSetId(client), hostedConfig)).resolves.toBe("set-new");
    expect(fakeCircle.createWalletSet).toHaveBeenCalledExactlyOnceWith({ name: HOSTED_SET });
  });
});

describe("walletIdempotencyKey", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("is a version-4-format UUID, the format Circle requires", () => {
    for (const account of ["acct-operating", "acct-reserve", "5d0f3a2e-8c1b-4f7a-9e6d-0000000000b9"]) {
      expect(walletIdempotencyKey(ORG, account)).toMatch(UUID_V4);
    }
  });

  it("is stable for the same organization and account", () => {
    expect(walletIdempotencyKey(ORG, "acct-operating")).toBe(walletIdempotencyKey(ORG, "acct-operating"));
    // Pinned, so a change to the derivation (which would mint a second wallet for a retried account) fails here.
    expect(walletIdempotencyKey("org-1", "account-1")).toBe("79149f9e-db49-43cf-833e-940d8a6f7a79");
  });

  it("differs by account and by organization", () => {
    const keys = new Set([
      walletIdempotencyKey(ORG, "acct-operating"),
      walletIdempotencyKey(ORG, "acct-reserve"),
      walletIdempotencyKey("0b6c1c9e-4a4f-4a7e-9b1e-000000000c1d", "acct-operating"),
    ]);
    expect(keys.size).toBe(3);
  });

  it("is derived from sha256 of vestiarion-wallet:<org>:<account>", async () => {
    const { createHash } = await import("node:crypto");
    const hex = createHash("sha256").update(`vestiarion-wallet:${ORG}:acct-operating`).digest("hex").slice(0, 32).split("");
    hex[12] = "4";
    hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    const joined = hex.join("");
    const expected = `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
    expect(walletIdempotencyKey(ORG, "acct-operating")).toBe(expected);
  });
});
