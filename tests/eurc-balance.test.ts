import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The operating wallet's EURC, shown on the balance tile beside its USDC: read from Arc testnet's public
 * RPC (EURC's `balanceOf`), never from Circle, so it costs no Circle call and needs nothing stored. Only a
 * live workspace's wallet is read; a sandbox has no EURC.
 */

const { chainModesMock } = vi.hoisted(() => ({ chainModesMock: vi.fn() }));
vi.mock("@/lib/circle", () => ({ chainModes: chainModesMock }));

import { operatingEurcBalance, readEurcBalance } from "@/lib/fx/eurc-balance";

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000e0ba1";
const WALLET = "0x97F85033bBD83870a841cF7153F35b387746B6b6";
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const rpc = (result: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(result === undefined ? { error: { message: "no" } } : { result }) }), { status }));

beforeEach(() => {
  chainModesMock.mockReset();
  chainModesMock.mockReturnValue({ mode: "live", earnMode: "simulate" });
});

describe("readEurcBalance", () => {
  it("asks EURC's balanceOf for the wallet, and reads the 6-decimal answer exactly", async () => {
    const fetch = rpc(`0x${(16_600_000).toString(16).padStart(64, "0")}`);
    expect(await readEurcBalance(WALLET, { fetch })).toBe(16.6);
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ method: "eth_call", params: [{ to: EURC, data: `0x70a08231${WALLET.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"] });
  });

  it("is null when the chain does not answer, or answers with something else", async () => {
    expect(await readEurcBalance(WALLET, { fetch: rpc(undefined) })).toBeNull();
    expect(await readEurcBalance(WALLET, { fetch: rpc("0x", 200) })).toBeNull();
    expect(await readEurcBalance(WALLET, { fetch: rpc("0x1", 500) })).toBeNull();
    const down = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await readEurcBalance(WALLET, { fetch: down as unknown as typeof fetch })).toBeNull();
  });
});

describe("operatingEurcBalance", () => {
  function database(address: string | null) {
    const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
      if (request.path === "/rest/v1/accounts") return { body: address === null ? null : { address } };
      throw new Error(`unexpected ${request.path}`);
    });
    return { fake, run: <T>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn) };
  }

  it("reads the live operating wallet's EURC", async () => {
    const d = database(WALLET);
    const fetch = rpc(`0x${(2_063_076).toString(16).padStart(64, "0")}`);
    expect(await d.run(() => operatingEurcBalance({ fetch }))).toBe(2.063076);
    expect(d.fake.requests[0].params.get("kind")).toBe("eq.operating");
  });

  it("reads nothing in a sandbox", async () => {
    chainModesMock.mockReturnValue({ mode: "simulate", earnMode: "simulate" });
    const d = database(WALLET);
    const fetch = rpc("0x0");
    expect(await d.run(() => operatingEurcBalance({ fetch }))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(d.fake.requests).toEqual([]);
  });

  it("is null for a workspace whose operating wallet has no address yet", async () => {
    const d = database(null);
    const fetch = rpc("0x0");
    expect(await d.run(() => operatingEurcBalance({ fetch }))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
