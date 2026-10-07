import { getAddress, parseEther } from "viem";
import { describe, expect, it } from "vitest";
import type { TreasuryChain } from "@/lib/treasury/chain";
import { passkeySetupCalls, spendingLimitSalt } from "@/lib/passkey-treasury";
import {
  choosePasskeyTreasury,
  chooseWalletTreasury,
  createAgentWallet,
  preparePasskeySetup,
  recordPasskeySetup,
  recordRecovery,
  skipRecovery,
  walletTreasuryStatus,
} from "@/lib/treasury/wallet-treasury";
import {
  ACTOR,
  AGENT,
  agentRow,
  APPROVE_TX,
  chain,
  circle,
  CONTRACT,
  database,
  NOW,
  ORG,
  ourCode,
  OWNER_EMAIL,
  sealLedgerKeysPerTest,
  signedProof,
  USDC,
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

describe("preparing a passkey wallet's setup (K6)", () => {
  const passkey = { org: { wallet_host: "external" }, operating: { address: WALLET } };
  const passkeyRow = (extra: Record<string, unknown> = {}) => agentRow({ treasury_signer: "passkey", ...extra });
  const none = { dailyUsdc: null, weeklyUsdc: null, capUsdc: null };
  const prepared = (state: World, onChain: TreasuryChain, figures: { dailyUsdc: number | null; weeklyUsdc: number | null; capUsdc: number | null } = none) =>
    database(state).inScope(() => preparePasskeySetup({ orgId: ORG, ...figures }, { chain: onChain }));
  const built = (deployed: boolean) =>
    passkeySetupCalls({
      usdc: USDC,
      treasury: WALLET,
      agent: AGENT,
      dailyUnits: 50_000_000n,
      weeklyUnits: 150_000_000n,
      capUnits: null,
      salt: spendingLimitSalt(ORG),
      deployed,
      gasWei: parseEther("0.5"),
    });

  it("builds the three calls with the workspace's figures, and says what it built them from", async () => {
    const expected = built(false);
    expect(await prepared(world({ ...passkey, contract: passkeyRow() }), chain())).toEqual({
      contract: expected.contract,
      salt: spendingLimitSalt(ORG),
      deployed: false,
      dailyUnits: "50000000",
      weeklyUnits: "150000000",
      capUnits: null,
      calls: expected.calls.map((call) => ({ ...call, value: call.value.toString() })),
      chainId: 5042,
    });
  });

  it("leaves the deployment out where the contract is at its address already (Review Focus 2)", async () => {
    const onChain = chain({ code: { [built(false).contract.toLowerCase()]: "0x6080" } });
    const setup = await prepared(world({ ...passkey, contract: passkeyRow() }), onChain);
    expect(setup.deployed).toBe(true);
    expect(setup.calls.map((call) => call.to)).toEqual(built(true).calls.map((call) => call.to));
  });

  it("is refused on the wallet route, before the agent's wallet, once approved, and for a cap of nothing", async () => {
    await expect(prepared(world({ ...passkey, contract: agentRow() }), chain())).rejects.toMatchObject({ code: "wrong_step" });
    await expect(prepared(world({ ...passkey, contract: passkeyRow({ agent_address: null, agent_wallet_id: null }) }), chain())).rejects.toMatchObject({
      code: "wrong_step",
    });
    await expect(
      prepared(world({ ...passkey, contract: passkeyRow({ address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true }) }), chain())
    ).rejects.toMatchObject({ code: "wrong_step" });
    await expect(prepared(world({ ...passkey, contract: passkeyRow() }), chain(), { ...none, capUsdc: 0 })).rejects.toMatchObject({ code: "invalid_figures" });
  });
});

describe("recording a passkey wallet's setup from the chain (K7)", () => {
  const passkey = { org: { wallet_host: "external" }, operating: { address: WALLET } };
  const SETUP_TX = `0x${"5e".repeat(32)}` as const;
  const ENTRYPOINT = getAddress("0x0000000071727de22e5e9d8baf0edac6f37da032");
  const BUNDLER = getAddress("0x00000000000000000000000000000000000b0d1e");
  const bundled = { status: "success" as const, from: BUNDLER, to: ENTRYPOINT, contractAddress: null };
  const setUp = (extra: Partial<Parameters<typeof chain>[0]> = {}) =>
    chain({ receipts: { [SETUP_TX]: bundled }, code: { [CONTRACT.toLowerCase()]: ourCode }, allowance: 2n ** 256n - 1n, gas: 500_000_000_000_000_000n, ...extra });
  const recordIt = (state: World, onChain: TreasuryChain, txHash: string = SETUP_TX) =>
    database(state).inScope(() => recordPasskeySetup({ orgId: ORG, actorId: ACTOR, txHash, contract: CONTRACT.toLowerCase() }, { chain: onChain }));
  const fresh = () => world({ ...passkey, contract: agentRow({ treasury_signer: "passkey" }) });

  it("records nothing while the setup is not mined, or its contract not yet shown", async () => {
    const state = fresh();
    expect(await recordIt(state, chain())).toBe("pending");
    expect(await recordIt(state, setUp({ code: {} }))).toBe("pending");
    expect(state.contract?.enforced).toBe(false);
    expect(state.ledger).toEqual([]);
  });

  it("refuses a setup that failed, a contract that is not Vestiarion's for this wallet and agent, and one the wallet did not approve", async () => {
    await expect(recordIt(fresh(), setUp({ receipts: { [SETUP_TX]: { ...bundled, status: "reverted" } } }))).rejects.toMatchObject({ code: "chain_refused" });
    await expect(recordIt(fresh(), setUp({ code: { [CONTRACT.toLowerCase()]: "0x6080" } }))).rejects.toMatchObject({ code: "chain_refused" });
    await expect(recordIt(fresh(), setUp({ allowance: 0n }))).rejects.toMatchObject({ code: "chain_refused" });
  });

  it("records the setup once, as the wallet route records its deployment and approval (Review Focus 2)", async () => {
    const state = fresh();
    expect(await recordIt(state, setUp())).toBe("verified");
    expect(state.contract).toMatchObject({ address: CONTRACT, deploy_tx_hash: SETUP_TX, approve_tx_hash: SETUP_TX, enforced: true });
    expect(state.budget).toMatchObject({ daily_usdc: 20, weekly_usdc: 60 });
    expect(state.ledger.map((entry) => entry.action)).toEqual(["agent_budget_changed", "spending_limit_deployed", "spending_limit_enforced"]);
    expect(state.ledger[2].detail).toEqual({
      by: ACTOR,
      contract: CONTRACT,
      agent: AGENT,
      treasury: WALLET,
      walletHost: "external",
      signer: "passkey",
      dailyUsdc: 20,
      weeklyUsdc: 60,
      deployTxHash: SETUP_TX,
      approveTxHash: SETUP_TX,
      setLimitsTxHash: null,
      allowanceUsdc: null,
    });
    expect(await recordIt(state, setUp())).toBe("verified");
    expect(state.ledger).toHaveLength(3);
    await expect(recordIt(state, setUp(), `0x${"5f".repeat(32)}`)).rejects.toMatchObject({ code: "wrong_step" });
  });

  it("is refused on the wallet route", async () => {
    await expect(recordIt(world({ ...passkey, contract: agentRow() }), setUp())).rejects.toMatchObject({ code: "wrong_step" });
  });
});

describe("a passkey wallet's recovery (K8)", () => {
  const passkey = { org: { wallet_host: "external" }, operating: { address: WALLET } };
  const RECOVERY = getAddress("0x5af3107a4000000000000000000000000000c0de");
  const RECOVERY_TX = `0x${"7e".repeat(32)}` as const;
  const done = { status: "success" as const, from: getAddress("0x00000000000000000000000000000000000b0d1e"), to: null, contractAddress: null };
  const setUpRow = (extra: Record<string, unknown> = {}) =>
    agentRow({ treasury_signer: "passkey", address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true, ...extra });
  const register = (state: World, onChain: TreasuryChain = chain({ receipts: { [RECOVERY_TX]: done } })) =>
    database(state).inScope(() => recordRecovery({ orgId: ORG, actorId: ACTOR, recoveryAddress: RECOVERY.toLowerCase(), txHash: RECOVERY_TX }, { chain: onChain }));
  const skip = (state: World) => database(state).inScope(() => skipRecovery({ orgId: ORG, actorId: ACTOR }));

  it("records the recovery address once its registration is mined, once", async () => {
    const state = world({ ...passkey, contract: setUpRow() });
    expect(await register(state, chain())).toBe("pending");
    expect(await register(state)).toBe("verified");
    expect(state.contract).toMatchObject({ recovery_address: RECOVERY });
    expect(await register(state)).toBe("verified");
    expect(state.ledger).toEqual([{ action: "treasury_recovery_registered", detail: { by: ACTOR, recoveryAddress: RECOVERY, txHash: RECOVERY_TX } }]);
  });

  it("refuses a registration that failed on chain", async () => {
    const failed = chain({ receipts: { [RECOVERY_TX]: { ...done, status: "reverted" } } });
    await expect(register(world({ ...passkey, contract: setUpRow() }), failed)).rejects.toMatchObject({ code: "chain_refused" });
  });

  it("records a skip once, and not after a recovery is registered", async () => {
    const state = world({ ...passkey, contract: setUpRow() });
    await skip(state);
    await skip(state);
    expect(state.contract?.recovery_skipped_at).toEqual(expect.any(String));
    expect(state.ledger).toEqual([{ action: "treasury_recovery_skipped", detail: { by: ACTOR } }]);
    await expect(skip(world({ ...passkey, contract: setUpRow({ recovery_address: RECOVERY }) }))).rejects.toMatchObject({ code: "wrong_step" });
  });

  it("is refused before setup, and on the wallet route", async () => {
    await expect(skip(world({ ...passkey, contract: agentRow({ treasury_signer: "passkey" }) }))).rejects.toMatchObject({ code: "wrong_step" });
    await expect(register(world({ ...passkey, contract: setUpRow({ treasury_signer: "wallet" }) }))).rejects.toMatchObject({ code: "wrong_step" });
  });
});

describe("the agent's wallet made with the choice (K4, final review I1)", () => {
  it("is made in the same request as the choice, whose scope was opened before the workspace chose its own wallet", async () => {
    const state = world();
    const { factory, createWallets } = circle();
    // One scope for both, as the action has it: its configuration was read before the choice changed the host.
    await database(state).inScope(async () => {
      await choosePasskeyTreasury({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, address: WALLET });
      await createAgentWallet({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL }, { circle: factory });
    });
    expect(createWallets).toHaveBeenCalledTimes(1);
    expect(state.contract).toMatchObject({ treasury_signer: "passkey", agent_address: AGENT });
    expect(state.ledger.map((entry) => entry.action)).toEqual(["treasury_wallet_chosen", "agent_wallet_created"]);
  });
});
