import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { TreasuryChain } from "@/lib/treasury/chain";
import { choosePasskeyTreasury, chooseWalletTreasury, walletTreasuryStatus } from "@/lib/treasury/wallet-treasury";
import {
  ACTOR,
  agentRow,
  APPROVE_TX,
  chain,
  CONTRACT,
  database,
  NOW,
  ORG,
  OWNER_EMAIL,
  sealLedgerKeysPerTest,
  signedProof,
  WALLET,
  world,
  type World,
} from "./support/wallet-treasury-world";

/**
 * A passkey wallet as the treasury (docs/superpowers/specs/2026-10-07-passkey-treasury-design.md K3, K8, K12): chosen by
 * its address alone, since control is proven on chain by its own approval later; the wallet route keeps its signed
 * proof and now says which kind of wallet signs; and the status says which route a workspace is on, what setup needs,
 * and whether its recovery was decided.
 */

sealLedgerKeysPerTest();

const OTHER = getAddress("0x5af3107a4000000000000000000000000000beef");

const choose = (state: World, address: string, actorEmail = OWNER_EMAIL) =>
  database(state).inScope(() => choosePasskeyTreasury({ orgId: ORG, actorId: ACTOR, actorEmail, address }));

describe("choosing a passkey wallet", () => {
  it("places its address as the treasury, says a passkey signs for it, and asks for no signature", async () => {
    const state = world();
    await choose(state, WALLET.toLowerCase());
    expect(state.org.wallet_host).toBe("external");
    expect(state.operating.address).toBe(WALLET);
    expect(state.contract).toMatchObject({ treasury_kind: "external", treasury_address: WALLET, treasury_signer: "passkey" });
    expect(state.ledger).toEqual([{ action: "treasury_wallet_chosen", detail: { by: ACTOR, address: WALLET, signer: "passkey", network: "arc-mainnet" } }]);
  });

  it("may be made again until the contract is deployed, and not after", async () => {
    const state = world();
    await choose(state, WALLET);
    await choose(state, OTHER);
    expect(state.operating.address).toBe(OTHER);
    expect(state.contract).toMatchObject({ treasury_address: OTHER, treasury_signer: "passkey" });
    state.contract = { ...state.contract!, address: CONTRACT };
    await expect(choose(state, WALLET)).rejects.toMatchObject({ code: "wrong_step" });
    expect(state.operating.address).toBe(OTHER);
  });

  it("is refused for a workspace with its own Circle account or wallets, for what is not an address, and where Arc mainnet is closed", async () => {
    for (const host of ["own", "hosted"]) {
      await expect(choose(world({ org: { wallet_host: host } }), WALLET)).rejects.toMatchObject({ code: "wrong_step" });
    }
    await expect(choose(world({ org: { circle_api_key_enc: { k: "t1" } } }), WALLET)).rejects.toMatchObject({ code: "wrong_step" });
    await expect(choose(world(), "0x12")).rejects.toMatchObject({ code: "proof_refused" });
    await expect(choose(world(), WALLET, "someone@else.com")).rejects.toMatchObject({ code: "not_allowed" });
    await expect(choose(world({ org: { mode: "live" } }), WALLET)).rejects.toMatchObject({ code: "wrong_step" });
  });
});

describe("choosing a browser wallet (Review Focus 5)", () => {
  it("keeps its signed proof, and says a browser wallet signs for it", async () => {
    const state = world();
    const proof = await signedProof(state);
    await database(state).inScope(() => chooseWalletTreasury({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, address: WALLET, ...proof }, { chain: chain(), now: NOW }));
    expect(state.contract).toMatchObject({ treasury_kind: "external", treasury_address: WALLET, treasury_signer: "wallet" });
    expect(state.ledger.map((entry) => entry.action)).toEqual(["treasury_wallet_proven"]);
  });
});

describe("walletTreasuryStatus on the passkey route", () => {
  const passkey = { org: { wallet_host: "external" }, operating: { address: WALLET } };
  const status = (state: World, onChain: TreasuryChain) => database(state).inScope(() => walletTreasuryStatus(ORG, { chain: onChain }));
  const fundedAndGassed = chain({ usdc: 12_500_000n, allowance: 2n ** 256n - 1n, gas: 500_000_000_000_000_000n });
  const enforced = (extra: Record<string, unknown> = {}) =>
    world({ ...passkey, contract: agentRow({ treasury_signer: "passkey", address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true, ...extra }) });

  it("says a passkey signs, and what setup needs: 0.50 USDC of gas and an estimated 0.05 USDC fee", async () => {
    const deploying = await status(world({ ...passkey, contract: agentRow({ treasury_signer: "passkey" }) }), chain({ usdc: 200_000n }));
    expect(deploying).toMatchObject({ step: "deploy", signer: "passkey", recovery: null, setupNeedsUsdc: 0.55, walletUsdc: 0.2 });
  });

  it("asks for the recovery after setup, and is ready once it is registered or skipped (Review Focus 4)", async () => {
    expect((await status(enforced(), fundedAndGassed)).step).toBe("recovery");
    expect(await status(enforced({ recovery_address: OTHER }), fundedAndGassed)).toMatchObject({ step: "ready", recovery: "registered" });
    expect(await status(enforced({ recovery_skipped_at: "2026-10-07T10:00:00Z" }), fundedAndGassed)).toMatchObject({ step: "ready", recovery: "skipped" });
  });

  it("leaves the wallet route as it was: no recovery step, nothing more to fund", async () => {
    const wallet = world({ ...passkey, contract: agentRow({ address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true }) });
    expect(await status(wallet, fundedAndGassed)).toMatchObject({ step: "ready", signer: "wallet", recovery: null, setupNeedsUsdc: 0 });
  });
});
