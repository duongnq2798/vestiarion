import { beforeEach, describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { chainModes, getChainProvider } from "@/lib/circle";
import { BatchNotSentError } from "@/lib/circle/batch";
import { MAINNET_NOT_CONNECTED, MAINNET_NOT_LIVE, MAINNET_OFF } from "@/lib/mainnet";
import { forgetPaymentsSwitch, PaymentsDisabledError } from "@/lib/payments-switch";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * A mainnet workspace's provider refuses every way of moving money while its network holds it
 * (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md M4, Review Focus 1): whatever path calls it, before an
 * account is read. And it never simulates a reserve where the network has no USYC (M5).
 */

const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "6a1f0c2e-8c1b-4f7a-9e6d-00000000ab01";
const keys = { circleApiKey: "LIVE_API_KEY:placeholder", circleEntitySecret: "placeholder-entity-secret" };
const TRANSFER = { fromAccountId: "operating", toAddress: "0x1111111111111111111111111111111111111111", amount: 1, memo: "m", idempotencyKey: "k" };
const EARN = { accountId: "operating", amount: 1, reserveAccountId: "reserve", key: "move-1" };

beforeEach(() => forgetPaymentsSwitch());

/** A scope on Arc mainnet, with Arc mainnet on, whose database answers every read with nothing: the platform's switch is on. */
function inMainnet<T>(chain: Record<string, unknown>, fn: () => Promise<T>) {
  const config = { ...base, mainnetEnabled: true, network: "arc-mainnet" as const, chain: { ...base.chain, ...keys, ...chain } };
  const fake = fakeSupabase(() => ({ body: null }));
  return { result: runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn), fake };
}

describe("a mainnet workspace's provider (mainnet go-live M4)", () => {
  it("refuses every way of moving money while the workspace is not live, before reading an account", async () => {
    const { result, fake } = inMainnet({ networkHold: MAINNET_NOT_LIVE }, async () => {
      const provider = getChainProvider();
      await expect(provider.transfer(TRANSFER)).rejects.toThrow(MAINNET_NOT_LIVE);
      await expect(provider.transfer(TRANSFER)).rejects.toBeInstanceOf(PaymentsDisabledError);
      const batch = provider.batchTransfer!({ fromAccountId: "operating", transfers: [{ toAddress: TRANSFER.toAddress, amount: 1 }, { toAddress: TRANSFER.toAddress, amount: 2 }], idempotencyKey: "b" });
      await expect(batch).rejects.toBeInstanceOf(BatchNotSentError);
      await expect(batch).rejects.toThrow(MAINNET_NOT_LIVE.replace(/\.$/, ""));
      await expect(
        provider.swapForEurc!({ fromAccountId: "operating", adapter: "0x3333333333333333333333333333333333333333", usdcIn: 1, callData: "0x", approveKey: "a", executeKey: "e" })
      ).rejects.toThrow(MAINNET_NOT_LIVE);
    });
    await result;
    expect(fake.requests.filter((request) => request.path === "/rest/v1/accounts")).toEqual([]);
  });

  it("names the switch when Arc mainnet is off", async () => {
    await inMainnet({ networkHold: MAINNET_OFF }, async () => {
      await expect(getChainProvider().transfer(TRANSFER)).rejects.toThrow(MAINNET_OFF);
    }).result;
  });

  it("refuses a simulated reserve where the network has no USYC, rather than pretend to sweep real money (M5)", async () => {
    await inMainnet({}, async () => {
      await expect(getChainProvider().depositToEarn(EARN)).rejects.toThrow("The USYC reserve does not run on Arc mainnet yet");
      await expect(getChainProvider().withdrawFromEarn(EARN)).rejects.toThrow("The USYC reserve does not run on Arc mainnet yet");
    }).result;
  });
});

describe("a mainnet workspace with no Circle account connected (mainnet go-live M5)", () => {
  it("gets no provider, never the simulator, and its pages read safely", async () => {
    await inMainnet({ circleApiKey: undefined, circleEntitySecret: undefined, networkHold: MAINNET_NOT_LIVE }, async () => {
      expect(() => getChainProvider()).toThrow(MAINNET_NOT_CONNECTED);
      expect(chainModes()).toEqual({ mode: "simulate", earnMode: "simulate" });
    }).result;
  });
});
