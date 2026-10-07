import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { SpendingLimitVerdict } from "@/lib/spending-limit/onchain";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

const { enforced } = vi.hoisted(() => ({ enforced: vi.fn() }));
vi.mock("@/lib/circle/spending-limit-setup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/circle/spending-limit-setup")>()),
  enforcedSpendingLimit: enforced,
}));

import { spendingLimitRef } from "@/lib/spending-limit/onchain";
import { ContractRefusal, personPaymentThroughContract } from "@/lib/treasury/person-payment";

/**
 * A person's payment from a workspace that pays from its owner's own wallet (docs/superpowers/specs/2026-10-07-wallet-
 * treasury-design.md W11): Vestiarion can move that wallet's USDC only through its contract, so a person's approval
 * goes through it too, after the contract's own answer, and is refused by name when the contract would refuse it.
 * Any other workspace's person pays as before.
 */

const CONTRACT = "0x5af3107a4000000000000000000000000000e5c0";
const AGENT = "0x5af3107a4000000000000000000000000000a9e7";
const PAYEE = "0x1111111111111111111111111111111111111111";
const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const external = { ...base, network: "arc-mainnet" as const, chain: { ...base.chain, walletHost: "external" as const } };
const own = { ...base, network: "arc-mainnet" as const, chain: { ...base.chain, walletHost: "own" as const } };
const inScope = <T>(config: typeof base, fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: "org-own-wallet" }), fn);
const input = { sourceType: "invoice" as const, sourceId: "inv-1", to: PAYEE, amount: 30, currency: "USDC" as const, crossChain: false };
const answer = (verdict: SpendingLimitVerdict) => vi.fn(async () => verdict);

beforeEach(() => {
  enforced.mockReset();
  enforced.mockResolvedValue({ contract: CONTRACT, agentWalletId: "agent-wallet", agentAddress: AGENT });
});

describe("personPaymentThroughContract", () => {
  it("is nothing for a workspace that pays from a Circle wallet", async () => {
    expect(await inScope(own, () => personPaymentThroughContract(input))).toBeNull();
    expect(enforced).not.toHaveBeenCalled();
  });

  it("goes through the contract, from the agent's wallet, under the payment's own ref, once the contract allows it", async () => {
    const verdict = answer({ state: "allowed" });
    expect(await inScope(external, () => personPaymentThroughContract(input, { verdict }))).toEqual({
      contract: CONTRACT,
      agentWalletId: "agent-wallet",
      ref: spendingLimitRef("invoice", "inv-1"),
    });
    expect(verdict).toHaveBeenCalledWith({ contract: CONTRACT, agent: AGENT, to: PAYEE, amount: 30, ref: spendingLimitRef("invoice", "inv-1") });
  });

  it("is refused, by name, past a figure, before anything is sent", async () => {
    const overDay = answer({ state: "refused", error: "OverDailyLimit", spent: 40, amount: 30, limit: 50 });
    await expect(inScope(external, () => personPaymentThroughContract(input, { verdict: overDay }))).rejects.toThrow(
      "Paying 30 USDC would pass the contract's daily limit of 50 USDC: 40 USDC paid so far."
    );
    const overWeek = answer({ state: "refused", error: "OverWeeklyLimit", spent: 140, amount: 30, limit: 150 });
    await expect(inScope(external, () => personPaymentThroughContract(input, { verdict: overWeek }))).rejects.toThrow("the contract's 7-day limit of 150 USDC");
    await expect(inScope(external, () => personPaymentThroughContract(input, { verdict: answer({ state: "refused", error: "AlreadyPaid" }) }))).rejects.toThrow(
      "The contract on Arc mainnet refused this payment (AlreadyPaid)."
    );
    await expect(inScope(external, () => personPaymentThroughContract(input, { verdict: answer({ state: "unreadable", reason: "no answer" }) }))).rejects.toThrow(
      "The contract on Arc mainnet could not be read; nothing was paid. Try again in a moment."
    );
  });

  it("is refused for EURC, for another chain, and while the wallet has not approved its contract", async () => {
    const verdict = answer({ state: "allowed" });
    await expect(inScope(external, () => personPaymentThroughContract({ ...input, currency: "EURC" }, { verdict }))).rejects.toThrow(
      "Only USDC on Arc mainnet can be paid from your wallet's contract."
    );
    await expect(inScope(external, () => personPaymentThroughContract({ ...input, crossChain: true }, { verdict }))).rejects.toBeInstanceOf(ContractRefusal);
    enforced.mockResolvedValueOnce(null);
    await expect(inScope(external, () => personPaymentThroughContract(input, { verdict }))).rejects.toThrow(
      "This workspace's wallet has not approved its spending limit contract, so nothing can be paid from it."
    );
  });

  it("asks the contract nothing for a payment that may have been sent already, which only goes through it again", async () => {
    const verdict = answer({ state: "refused", error: "AlreadyPaid" });
    expect(await inScope(external, () => personPaymentThroughContract({ ...input, check: false }, { verdict }))).toMatchObject({ contract: CONTRACT });
    expect(verdict).not.toHaveBeenCalled();
  });
});
