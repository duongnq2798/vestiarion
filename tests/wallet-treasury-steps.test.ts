import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, type Hex } from "viem";
import type { TreasuryChain } from "@/lib/treasury/chain";
import { deploymentData } from "@/lib/treasury/verify";
import {
  chooseWalletTreasury,
  createAgentWallet,
  prepareAgentGas,
  prepareApproval,
  prepareDeployment,
  proofMessage,
  recordApproval,
  recordDeployment,
  WalletTreasuryError,
  walletTreasuryStatus,
} from "@/lib/treasury/wallet-treasury";
import {
  ACTOR,
  AGENT,
  agentRow,
  APPROVE_TX,
  approvedOnUsdc,
  chain,
  chosen,
  circle,
  CONTRACT,
  database,
  DEPLOY_TX,
  deployedAt,
  NOW,
  ORG,
  ourCode,
  OWNER_EMAIL,
  REDEPLOY_TX,
  SECOND_CONTRACT,
  signedProof,
  USDC,
  sealLedgerKeysPerTest,
  WALLET,
  world,
  type World,
} from "./support/wallet-treasury-world";

/**
 * The setup of a workspace that pays from its owner's own wallet (docs/superpowers/specs/2026-10-07-wallet-treasury-
 * design.md W3, W5–W10): the owner proves their wallet, Vestiarion creates the agent's wallet, the owner deploys and
 * approves the contract from their wallet, and sends the agent its gas. Each step checks the one before it, and each
 * result the owner hands back is read from the chain before it is recorded.
 */

sealLedgerKeysPerTest();

describe("proving the owner's wallet", () => {
  it("records the wallet as the workspace's treasury, with the proof in the ledger", async () => {
    const state = world();
    const { inScope } = database(state);
    const proof = await signedProof(state);
    await inScope(() => chooseWalletTreasury({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, address: WALLET.toLowerCase(), ...proof }, { chain: chain(), now: NOW }));
    expect(state.org.wallet_host).toBe("external");
    expect(state.operating.address).toBe(WALLET);
    expect(state.ledger).toEqual([
      { action: "treasury_wallet_proven", detail: { by: ACTOR, address: WALLET, message: proof.message, signature: proof.signature, network: "arc-mainnet" } },
    ]);
  });

  it("gives the message to sign for this workspace, naming the wallet", async () => {
    const state = world();
    const { inScope } = database(state);
    const message = await inScope(() => proofMessage({ orgId: ORG, address: WALLET.toLowerCase() }));
    expect(message).toContain("Workspace: own-wallet-co");
    expect(message).toContain(`Wallet: ${WALLET}`);
  });

  it("refuses a workspace that chose its wallets already, a contract's address, a bad proof, and a person Arc mainnet is not open to", async () => {
    for (const host of ["own", "hosted"]) {
      const state = world({ org: { wallet_host: host } });
      const proof = await signedProof(state);
      await expect(
        database(state).inScope(() => chooseWalletTreasury({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, address: WALLET, ...proof }, { chain: chain(), now: NOW }))
      ).rejects.toMatchObject({ code: "wrong_step" });
    }
    const contract = world();
    const contractProof = await signedProof(contract);
    await expect(
      database(contract).inScope(() =>
        chooseWalletTreasury({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, address: WALLET, ...contractProof }, { chain: chain({ code: { [WALLET.toLowerCase()]: "0x6080" } }), now: NOW })
      )
    ).rejects.toMatchObject({ code: "not_an_eoa" });
    const stale = world();
    const staleProof = await signedProof(stale, new Date(NOW - 20 * 60_000).toISOString());
    await expect(
      database(stale).inScope(() => chooseWalletTreasury({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, address: WALLET, ...staleProof }, { chain: chain(), now: NOW }))
    ).rejects.toMatchObject({ code: "proof_refused" });
    const closed = world();
    const closedProof = await signedProof(closed);
    await expect(
      database(closed).inScope(() => chooseWalletTreasury({ orgId: ORG, actorId: ACTOR, actorEmail: "someone@else.com", address: WALLET, ...closedProof }, { chain: chain(), now: NOW }))
    ).rejects.toMatchObject({ code: "not_allowed" });
    expect([contract, stale, closed].every((state) => state.org.wallet_host === null)).toBe(true);
  });
});

describe("the agent's wallet", () => {
  it("is created once, in Vestiarion's agent account, and kept", async () => {
    const state = world(chosen);
    const { inScope } = database(state);
    const { factory, createWallets } = circle();
    await inScope(() => createAgentWallet({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL }, { circle: factory }));
    await inScope(() => createAgentWallet({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL }, { circle: factory }));
    expect(createWallets).toHaveBeenCalledTimes(1);
    expect(createWallets).toHaveBeenCalledWith(expect.objectContaining({ blockchains: ["ARC"], accountType: "EOA", walletSetId: "set-agents" }));
    expect(state.contract).toMatchObject({ treasury_kind: "external", treasury_address: WALLET, agent_wallet_id: "agent-wallet-1", agent_address: AGENT });
    expect(state.ledger.map((entry) => entry.action)).toEqual(["agent_wallet_created"]);
    expect(state.ledger[0].detail).toEqual({ by: ACTOR, address: AGENT });
  });

  it("waits for the owner's wallet", async () => {
    const state = world();
    await expect(database(state).inScope(() => createAgentWallet({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL }, { circle: circle().factory }))).rejects.toMatchObject({
      code: "wrong_step",
    });
  });
});

describe("deploying the contract from the owner's wallet", () => {
  it("builds the deployment with the workspace's figures, or the owner's", async () => {
    const state = world({ ...chosen, contract: agentRow() });
    const { inScope } = database(state);
    const defaults = await inScope(() => prepareDeployment({ orgId: ORG, dailyUsdc: null, weeklyUsdc: null }));
    expect(defaults).toEqual({ to: null, data: deploymentData({ usdc: USDC, treasury: WALLET, agent: AGENT, dailyUnits: 50_000_000n, weeklyUnits: 150_000_000n }), value: "0", chainId: 5042 });
    // An empty figure is the workspace's own, each on its own: leaving one empty never deploys it as "no limit".
    const dailyOnly = await inScope(() => prepareDeployment({ orgId: ORG, dailyUsdc: 20, weeklyUsdc: null }));
    expect(dailyOnly.data).toBe(deploymentData({ usdc: USDC, treasury: WALLET, agent: AGENT, dailyUnits: 20_000_000n, weeklyUnits: 150_000_000n }));
    const weeklyOnly = await inScope(() => prepareDeployment({ orgId: ORG, dailyUsdc: null, weeklyUsdc: 1000 }));
    expect(weeklyOnly.data).toBe(deploymentData({ usdc: USDC, treasury: WALLET, agent: AGENT, dailyUnits: 50_000_000n, weeklyUnits: 1_000_000_000n }));
    // Refused: a figure of 0 or below, the 7-day figure below the daily one (the workspace's 150 below a typed 200), and a
    // figure too small to be one unit of USDC, which the contract would read as no limit.
    for (const [dailyUsdc, weeklyUsdc] of [[0, 10], [-1, null], [30, 20], [200, null], [0.0000001, null]] as const) {
      await expect(inScope(() => prepareDeployment({ orgId: ORG, dailyUsdc, weeklyUsdc }))).rejects.toMatchObject({ code: "invalid_figures" });
    }
  });

  it("records nothing while the deployment is not mined", async () => {
    const state = world({ ...chosen, contract: agentRow() });
    expect(await database(state).inScope(() => recordDeployment({ orgId: ORG, actorId: ACTOR, txHash: DEPLOY_TX }, { chain: chain() }))).toBe("pending");
    expect(state.contract?.address).toBeNull();
    expect(state.ledger).toEqual([]);
  });

  it("records a verified deployment, its figures as the workspace's limit, and replaces one not yet approved", async () => {
    const state = world({ ...chosen, contract: agentRow() });
    const { inScope } = database(state);
    const onChain = chain({
      receipts: { [DEPLOY_TX]: deployedAt(CONTRACT), [REDEPLOY_TX]: deployedAt(SECOND_CONTRACT) },
      code: { [CONTRACT.toLowerCase()]: ourCode, [SECOND_CONTRACT.toLowerCase()]: ourCode },
    });
    expect(await inScope(() => recordDeployment({ orgId: ORG, actorId: ACTOR, txHash: DEPLOY_TX }, { chain: onChain }))).toBe("verified");
    expect(state.contract).toMatchObject({ address: CONTRACT, deploy_tx_hash: DEPLOY_TX });
    expect(state.budget).toMatchObject({ daily_usdc: 20, weekly_usdc: 60 });
    expect(state.ledger.map((entry) => entry.action)).toEqual(["agent_budget_changed", "spending_limit_deployed"]);
    expect(state.ledger[1].detail).toEqual({ by: ACTOR, contract: CONTRACT, txHash: DEPLOY_TX, dailyUsdc: 20, weeklyUsdc: 60 });

    expect(await inScope(() => recordDeployment({ orgId: ORG, actorId: ACTOR, txHash: REDEPLOY_TX }, { chain: onChain }))).toBe("verified");
    expect(state.contract).toMatchObject({ address: SECOND_CONTRACT, deploy_tx_hash: REDEPLOY_TX });
  });

  it("refuses to replace an approved contract, and refuses a deployment that is not the workspace's", async () => {
    const approved = world({ ...chosen, contract: agentRow({ address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true }) });
    await expect(
      database(approved).inScope(() => recordDeployment({ orgId: ORG, actorId: ACTOR, txHash: REDEPLOY_TX }, { chain: chain({ receipts: { [REDEPLOY_TX]: deployedAt(SECOND_CONTRACT) } }) }))
    ).rejects.toMatchObject({ code: "wrong_step" });
    const foreign = world({ ...chosen, contract: agentRow() });
    await expect(
      database(foreign).inScope(() =>
        recordDeployment({ orgId: ORG, actorId: ACTOR, txHash: DEPLOY_TX }, { chain: chain({ receipts: { [DEPLOY_TX]: deployedAt(CONTRACT) }, code: { [CONTRACT.toLowerCase()]: "0x6080" } }) })
      )
    ).rejects.toMatchObject({ code: "chain_refused" });
    expect(foreign.contract?.address).toBeNull();
  });
});

describe("approving the contract", () => {
  it("builds the approval on USDC, unlimited or capped", async () => {
    const state = world({ ...chosen, contract: agentRow({ address: CONTRACT }) });
    const { inScope } = database(state);
    const unlimited = await inScope(() => prepareApproval({ orgId: ORG, capUsdc: null }));
    expect(unlimited).toMatchObject({ to: USDC, value: "0", chainId: 5042 });
    expect(decodeFunctionData({ abi: erc20Abi, data: unlimited.data as Hex }).args).toEqual([CONTRACT, 2n ** 256n - 1n]);
    const capped = await inScope(() => prepareApproval({ orgId: ORG, capUsdc: 250 }));
    expect(decodeFunctionData({ abi: erc20Abi, data: capped.data as Hex }).args).toEqual([CONTRACT, 250_000_000n]);
  });

  it("enforces the contract once the approval is read on chain, recorded in the shape a Circle wallet's enforcement has", async () => {
    const state = world({ ...chosen, contract: agentRow({ address: CONTRACT, deploy_tx_hash: DEPLOY_TX }) });
    const { inScope } = database(state);
    const onChain = chain({ receipts: { [APPROVE_TX]: approvedOnUsdc }, allowance: 2n ** 256n - 1n });
    expect(await inScope(() => recordApproval({ orgId: ORG, actorId: ACTOR, txHash: APPROVE_TX }, { chain: onChain }))).toBe("verified");
    expect(state.contract).toMatchObject({ approve_tx_hash: APPROVE_TX, enforced: true });
    expect(state.ledger).toEqual([
      {
        action: "spending_limit_enforced",
        detail: {
          by: ACTOR,
          contract: CONTRACT,
          agent: AGENT,
          // The treasury is the owner's wallet, as it is the operating wallet's address for a Circle wallet.
          treasury: WALLET,
          walletHost: "external",
          dailyUsdc: 50,
          weeklyUsdc: 150,
          deployTxHash: DEPLOY_TX,
          approveTxHash: APPROVE_TX,
          setLimitsTxHash: null,
          allowanceUsdc: null,
        },
      },
    ]);
  });

  it("refuses an approval that leaves the contract nothing", async () => {
    const state = world({ ...chosen, contract: agentRow({ address: CONTRACT }) });
    await expect(
      database(state).inScope(() => recordApproval({ orgId: ORG, actorId: ACTOR, txHash: APPROVE_TX }, { chain: chain({ receipts: { [APPROVE_TX]: approvedOnUsdc }, allowance: 0n }) }))
    ).rejects.toMatchObject({ code: "chain_refused" });
    expect(state.contract?.enforced).toBe(false);
  });
});

describe("the agent's gas, on a network where it pays its own", () => {
  it("is 0.50 USDC sent to the agent from the owner's wallet", async () => {
    const state = world({ ...chosen, contract: agentRow({ address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true }) });
    expect(await database(state).inScope(() => prepareAgentGas({ orgId: ORG }))).toEqual({ to: AGENT, data: "0x", value: "500000000000000000", chainId: 5042 });
  });
});

describe("walletTreasuryStatus", () => {
  it("walks every step, from the wallet to ready", async () => {
    const status = (state: World, onChain: TreasuryChain) => database(state).inScope(() => walletTreasuryStatus(ORG, { chain: onChain }));
    expect((await status(world(), chain())).step).toBe("wallet");
    expect((await status(world(chosen), chain())).step).toBe("agent");
    expect((await status(world({ ...chosen, contract: agentRow() }), chain())).step).toBe("deploy");
    expect((await status(world({ ...chosen, contract: agentRow({ address: CONTRACT }) }), chain())).step).toBe("approve");
    const enforced = world({ ...chosen, contract: agentRow({ address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true }) });
    expect((await status(enforced, chain({ gas: 50_000_000_000_000_000n }))).step).toBe("gas");
    const ready = await status(enforced, chain({ usdc: 12_500_000n, allowance: 2n ** 256n - 1n, gas: 500_000_000_000_000_000n }));
    expect(ready).toEqual({
      step: "ready",
      wallet: WALLET,
      agent: AGENT,
      contract: CONTRACT,
      dailyUsdc: 20,
      weeklyUsdc: 60,
      walletUsdc: 12.5,
      spendableUsdc: 12.5,
      agentGasUsdc: 0.5,
      agentGasMinimumUsdc: 0.1,
    });
  });

  it("keeps the step and leaves a figure out when the chain cannot be read", async () => {
    const enforced = world({ ...chosen, contract: agentRow({ address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true }) });
    const broken = { ...chain(), nativeBalance: async () => { throw new Error("rpc down"); } } as TreasuryChain;
    const status = await database(enforced).inScope(() => walletTreasuryStatus(ORG, { chain: broken }));
    expect(status.step).toBe("gas");
    expect(status.agentGasUsdc).toBeNull();
  });
});

describe("WalletTreasuryError", () => {
  it("carries its code and a message", () => {
    const error = new WalletTreasuryError("invalid_figures");
    expect(error.code).toBe("invalid_figures");
    expect(error.message.length).toBeGreaterThan(10);
  });
});

