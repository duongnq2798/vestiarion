import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { connectCircleAction, createWalletsAction, goLiveAction, refreshBalanceAction, type BalanceActionResult, type GoLiveActionResult } from "@/app/actions/go-live";
import { GoLiveError } from "@/lib/platform/go-live";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * `src/app/actions/go-live.ts` against a real `inOrg`, the same shape as
 * `tests/webhooks-actions.test.ts`: `server-only`, `authorize` and the three
 * library functions are stand-ins — the library is proven in
 * `tests/go-live-lib.test.ts` — while `inOrg` and the org lookup it makes are
 * real, against a fake network that only answers the organization row.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000d0d",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000fd",
}));

const API_KEY = "TEST_API_KEY:action-key-id:action-key-secret-value";
const ENTITY_SECRET = "beef".repeat(16);

vi.mock("server-only", () => ({}));

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));

const { connectCircleMock, createWalletsMock, goLiveMock, operatingBalanceMock } = vi.hoisted(() => ({
  connectCircleMock: vi.fn(),
  createWalletsMock: vi.fn(),
  goLiveMock: vi.fn(),
  operatingBalanceMock: vi.fn(),
}));
vi.mock("@/lib/platform/go-live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/go-live")>();
  return { ...actual, connectCircle: connectCircleMock, createWallets: createWalletsMock, goLive: goLiveMock, operatingBalance: operatingBalanceMock };
});

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

function orgRow() {
  return { id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: orgRow() } : { body: [] }));
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}

const owner = () => ({
  ok: true,
  user: { id: USER, email: null },
  membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "sandbox" as const, role: "owner" as const },
});

const INITIAL: GoLiveActionResult = { ok: false, message: "" };

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("orgSlug", "northstar");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const connectForm = () => form({ apiKey: API_KEY, entitySecret: ENTITY_SECRET });

const ACTIONS = [
  ["connectCircleAction", connectCircleAction, connectForm, connectCircleMock],
  ["createWalletsAction", createWalletsAction, () => form(), createWalletsMock],
  ["goLiveAction", goLiveAction, () => form(), goLiveMock],
] as const;

const logged: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 6 }))).join(" "));
    });
  }
});

afterEach(() => {
  for (const line of logged) {
    expect(line).not.toContain(API_KEY);
    expect(line).not.toContain(ENTITY_SECRET);
  }
  vi.restoreAllMocks();
});

/** The returned state: exactly `{ ok, message }`, and nothing secret in it. */
function expectSafe(result: GoLiveActionResult): void {
  expect(Object.keys(result).sort()).toEqual(["message", "ok"]);
  expect(JSON.stringify(result)).not.toContain(API_KEY);
  expect(JSON.stringify(result)).not.toContain(ENTITY_SECRET);
}

describe.each(ACTIONS)("%s", (name, action, makeForm, libraryMock) => {
  it("uses the owner-only permission literal org.administer", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "refused" });
    await action(INITIAL, makeForm());
    expect(authorizeMock).toHaveBeenCalledWith("northstar", "org.administer");
  });

  it("returns the refusal when authorize refuses, and never reaches the library", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace (admin) cannot do that." });
    const result = await action(INITIAL, makeForm());
    expect(result).toEqual({ ok: false, message: "Your role in this workspace (admin) cannot do that." });
    expect(libraryMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("returns a GoLiveError's own message", async () => {
    authorizeMock.mockResolvedValueOnce(owner());
    libraryMock.mockRejectedValueOnce(new GoLiveError("already_live"));
    const result = await run(() => action(INITIAL, makeForm()));
    expect(result).toEqual({ ok: false, message: "This workspace is already live." });
    expectSafe(result);
    expect(logged).toEqual([]);
  });

  it("returns the generic message for anything else, logging the action's name only", async () => {
    authorizeMock.mockResolvedValueOnce(owner());
    libraryMock.mockRejectedValueOnce(new Error(`request failed: Bearer ${API_KEY} ${ENTITY_SECRET}`));
    const result = await run(() => action(INITIAL, makeForm()));
    expect(result).toEqual({ ok: false, message: "Something went wrong; try again." });
    expectSafe(result);
    expect(logged).toEqual([`go-live: ${name} failed`]);
  });

  it("revalidates the workspace's pages on success", async () => {
    authorizeMock.mockResolvedValueOnce(owner());
    libraryMock.mockResolvedValueOnce(name === "createWalletsAction" ? { created: 2, skipped: 0 } : undefined);
    const result = await run(() => action(INITIAL, makeForm()));
    expect(result.ok).toBe(true);
    expectSafe(result);
    expect(revalidatePathMock).toHaveBeenCalledWith("/o/[slug]", "layout");
  });
});

describe("connectCircleAction", () => {
  it("passes the org, the actor and the pasted values through, and never returns them", async () => {
    authorizeMock.mockResolvedValueOnce(owner());
    connectCircleMock.mockResolvedValueOnce(undefined);

    const result = await run(() => connectCircleAction(INITIAL, connectForm()));

    expect(connectCircleMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, apiKey: API_KEY, entitySecret: ENTITY_SECRET });
    expect(result).toEqual({ ok: true, message: "Circle is connected." });
    expect(logged).toEqual([]);
  });

  it("passes missing fields as empty strings, for the library to refuse", async () => {
    authorizeMock.mockResolvedValueOnce(owner());
    connectCircleMock.mockRejectedValueOnce(new GoLiveError("invalid"));

    const result = await run(() => connectCircleAction(INITIAL, form()));

    expect(connectCircleMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, apiKey: "", entitySecret: "" });
    expect(result).toEqual({ ok: false, message: "Paste both the API key and the entity secret." });
  });

  it.each([
    ["key_rejected", "Circle did not accept this API key."],
    ["unreachable", "Could not reach Circle; try again."],
    ["different_entity", "This workspace is live; its wallets belong to the connected Circle account."],
  ] as const)("returns %s's message without the pasted values", async (code, message) => {
    authorizeMock.mockResolvedValueOnce(owner());
    connectCircleMock.mockRejectedValueOnce(new GoLiveError(code));
    const result = await run(() => connectCircleAction(INITIAL, connectForm()));
    expect(result).toEqual({ ok: false, message });
    expectSafe(result);
  });
});

describe("createWalletsAction", () => {
  it("passes the org and actor through, and says how many wallets were created", async () => {
    authorizeMock.mockResolvedValueOnce(owner());
    createWalletsMock.mockResolvedValueOnce({ created: 2, skipped: 0 });
    const result = await run(() => createWalletsAction(INITIAL, form()));
    expect(createWalletsMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER });
    expect(result).toEqual({ ok: true, message: "Treasury wallets created: 2." });
  });

  it("says so when every account already had a wallet", async () => {
    authorizeMock.mockResolvedValueOnce(owner());
    createWalletsMock.mockResolvedValueOnce({ created: 0, skipped: 2 });
    const result = await run(() => createWalletsAction(INITIAL, form()));
    expect(result).toEqual({ ok: true, message: "Every account already has a wallet." });
  });

  it("maps a rejected entity secret, and revalidates to show wallets created before it", async () => {
    authorizeMock.mockResolvedValueOnce(owner());
    createWalletsMock.mockRejectedValueOnce(new GoLiveError("entity_secret_rejected"));
    const result = await run(() => createWalletsAction(INITIAL, form()));
    expect(result).toEqual({ ok: false, message: "Circle did not accept the entity secret; reconnect with the right one." });
    expect(revalidatePathMock).toHaveBeenCalledWith("/o/[slug]", "layout");
  });

  it.each([
    ["not_connected", "Connect Circle first."],
    ["already_live", "This workspace is already live."],
  ] as const)("returns %s's message", async (code, message) => {
    authorizeMock.mockResolvedValueOnce(owner());
    createWalletsMock.mockRejectedValueOnce(new GoLiveError(code));
    await expect(run(() => createWalletsAction(INITIAL, form()))).resolves.toEqual({ ok: false, message });
  });
});

describe("goLiveAction", () => {
  it("passes the org and actor through", async () => {
    authorizeMock.mockResolvedValueOnce(owner());
    goLiveMock.mockResolvedValueOnce(undefined);
    const result = await run(() => goLiveAction(INITIAL, form()));
    expect(goLiveMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER });
    expect(result).toEqual({ ok: true, message: "This workspace is live." });
  });

  it.each([
    ["not_connected", "Connect Circle first."],
    ["no_wallets", "Create the treasury wallets first."],
    ["already_live", "This workspace is already live."],
  ] as const)("returns %s's message", async (code, message) => {
    authorizeMock.mockResolvedValueOnce(owner());
    goLiveMock.mockRejectedValueOnce(new GoLiveError(code));
    await expect(run(() => goLiveAction(INITIAL, form()))).resolves.toEqual({ ok: false, message });
  });
});

describe("refreshBalanceAction", () => {
  const BALANCE_INITIAL: BalanceActionResult = { ok: false, message: "", balance: null };

  it("uses the owner-only permission literal org.administer, and returns the refusal", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "refused" });
    const result = await refreshBalanceAction(BALANCE_INITIAL, form());
    expect(authorizeMock).toHaveBeenCalledWith("northstar", "org.administer");
    expect(result).toEqual({ ok: false, message: "refused", balance: null });
    expect(operatingBalanceMock).not.toHaveBeenCalled();
  });

  it("returns the number and nothing else, and revalidates nothing: it only reads", async () => {
    authorizeMock.mockResolvedValueOnce(owner());
    operatingBalanceMock.mockResolvedValueOnce(12.5);
    const result = await run(() => refreshBalanceAction(BALANCE_INITIAL, form()));
    expect(result).toEqual({ ok: true, message: "", balance: 12.5 });
    expect(operatingBalanceMock).toHaveBeenCalledOnce();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("returns a GoLiveError's own message", async () => {
    authorizeMock.mockResolvedValueOnce(owner());
    operatingBalanceMock.mockRejectedValueOnce(new GoLiveError("no_wallets"));
    const result = await run(() => refreshBalanceAction(BALANCE_INITIAL, form()));
    expect(result).toEqual({ ok: false, message: "Create the treasury wallets first.", balance: null });
    expect(logged).toEqual([]);
  });

  it("returns a fixed message for anything else, logging the action's name only", async () => {
    authorizeMock.mockResolvedValueOnce(owner());
    operatingBalanceMock.mockRejectedValueOnce(new Error(`request failed: Bearer ${API_KEY} ${ENTITY_SECRET}`));
    const result = await run(() => refreshBalanceAction(BALANCE_INITIAL, form()));
    expect(result).toEqual({ ok: false, message: "Could not read the balance from Circle; try again.", balance: null });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(logged).toEqual(["go-live: refreshBalanceAction failed"]);
  });
});
