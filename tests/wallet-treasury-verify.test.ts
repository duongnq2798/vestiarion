import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, getAddress, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SPENDING_LIMIT_ABI } from "@/lib/spending-limit/onchain";
import type { TreasuryChain, TreasuryReceipt } from "@/lib/treasury/chain";
import { deploymentData, verifyApproval, verifyDeployedAt, verifyDeployment, verifyWalletProof, walletProofMessage } from "@/lib/treasury/verify";
import { ARC_MAINNET } from "@/lib/network";

/**
 * What the server checks before it trusts an owner's wallet, their contract and their approval (docs/superpowers/
 * specs/2026-10-07-wallet-treasury-design.md W3, W8, W9): a fresh signature from the wallet itself, a deployment from
 * that wallet whose code is exactly what Vestiarion's contract deployed with that wallet and the workspace's agent
 * leaves, and an approval from that wallet on USDC. Addresses match in any case (Review Focus 3).
 */

// Hardhat's first public test key: a well-known throwaway, never funded anywhere real.
const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const STRANGER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const WALLET = OWNER.address;
const AGENT = getAddress("0x5af3107a4000000000000000000000000000a9e7");
const OTHER_AGENT = getAddress("0x5af3107a4000000000000000000000000000a9e8");
const CONTRACT = getAddress("0x5af3107a4000000000000000000000000000e5c0");
const USDC = getAddress(ARC_MAINNET.tokens.USDC);
const DEPLOY_TX = `0x${"d1".repeat(32)}` as Hex;
const APPROVE_TX = `0x${"a1".repeat(32)}` as Hex;
const NOW = Date.parse("2026-10-07T10:00:00Z");

describe("the owner's proof of their wallet", () => {
  const issuedAt = "2026-10-07T09:58:00.000Z";
  const message = walletProofMessage({ orgSlug: "own-wallet-co", network: ARC_MAINNET, address: WALLET.toLowerCase() as Hex, issuedAt });

  it("names the workspace, the network, the wallet and the time, one per line", () => {
    expect(message).toBe(
      ["Vestiarion: pay from this wallet", "Workspace: own-wallet-co", "Network: Arc mainnet (chain 5042)", `Wallet: ${WALLET}`, `Issued: ${issuedAt}`].join("\n")
    );
  });

  it("accepts the wallet's own fresh signature, whatever case the address came in", async () => {
    const signature = await OWNER.signMessage({ message });
    expect(await verifyWalletProof({ message, signature, address: WALLET.toLowerCase() as Hex, orgSlug: "own-wallet-co", network: ARC_MAINNET, now: NOW })).toEqual({
      ok: true,
      issuedAt,
    });
  });

  it("refuses another wallet's signature, a stale one, one from the future, and one for another workspace", async () => {
    const theirs = await STRANGER.signMessage({ message });
    expect((await verifyWalletProof({ message, signature: theirs, address: WALLET, orgSlug: "own-wallet-co", network: ARC_MAINNET, now: NOW })).ok).toBe(false);

    const signature = await OWNER.signMessage({ message });
    const later = NOW + 11 * 60_000;
    expect((await verifyWalletProof({ message, signature, address: WALLET, orgSlug: "own-wallet-co", network: ARC_MAINNET, now: later })).ok).toBe(false);
    const early = Date.parse(issuedAt) - 2 * 60_000;
    expect((await verifyWalletProof({ message, signature, address: WALLET, orgSlug: "own-wallet-co", network: ARC_MAINNET, now: early })).ok).toBe(false);
    expect((await verifyWalletProof({ message, signature, address: WALLET, orgSlug: "someone-else", network: ARC_MAINNET, now: NOW })).ok).toBe(false);
  });
});

/** A chain whose receipts and code are given, and whose simulated deployment leaves a code that names its arguments. */
function fakeChain(input: { receipts: Record<string, TreasuryReceipt | null>; deployedWith?: Hex; allowance?: bigint }): TreasuryChain {
  return {
    receipt: async (hash) => input.receipts[hash.toLowerCase()] ?? null,
    code: async (address) => (address.toLowerCase() === CONTRACT.toLowerCase() && input.deployedWith ? keccak256(input.deployedWith) : "0x"),
    simulateDeploy: async ({ data }) => keccak256(data),
    read: async (_to, data) => {
      const { functionName } = decodeFunctionData({ abi: SPENDING_LIMIT_ABI, data });
      return encodeAbiParameters([{ type: "uint256" }], [functionName === "dailyLimit" ? 50_000_000n : 150_000_000n]);
    },
    usdcBalance: async () => 0n,
    allowance: async () => input.allowance ?? 0n,
    nativeBalance: async () => 0n,
  };
}

const receipt = (fields: Partial<TreasuryReceipt>): TreasuryReceipt => ({ status: "success", from: WALLET, to: null, contractAddress: CONTRACT, ...fields });
// What the wallet deployed: Vestiarion's contract for this wallet and agent, its figures aside (storage, not code).
const deployed = deploymentData({ usdc: USDC, treasury: WALLET, agent: AGENT, dailyUnits: 1n, weeklyUnits: 1n });

describe("verifyDeployment", () => {
  const check = (chain: TreasuryChain, agent: Hex = AGENT) => verifyDeployment(chain, { txHash: DEPLOY_TX, usdc: USDC, treasury: WALLET.toLowerCase() as Hex, agent });

  it("waits while the deployment is not mined", async () => {
    expect(await check(fakeChain({ receipts: {} }))).toEqual({ state: "pending" });
  });

  it("refuses one that failed, came from another wallet, or deployed nothing", async () => {
    for (const fields of [{ status: "reverted" as const }, { from: STRANGER.address }, { contractAddress: null }]) {
      const outcome = await check(fakeChain({ receipts: { [DEPLOY_TX]: receipt(fields) }, deployedWith: deployed }));
      expect(outcome.state, JSON.stringify(fields)).toBe("refused");
    }
  });

  it("refuses a contract whose code is not Vestiarion's for this wallet and agent", async () => {
    const outcome = await check(fakeChain({ receipts: { [DEPLOY_TX]: receipt({}) }, deployedWith: deployed }), OTHER_AGENT);
    expect(outcome).toMatchObject({ state: "refused" });
  });

  it("waits for a node that shows the receipt but not yet the code it deployed", async () => {
    // A load-balanced RPC can answer the receipt from one node and the code from another, behind it.
    expect(await check(fakeChain({ receipts: { [DEPLOY_TX]: receipt({}) } }))).toEqual({ state: "pending" });
  });

  it("cannot check a deployment where the node simulates no creation, and never calls the contract someone else's", async () => {
    // An RPC without creation calls would otherwise refuse every deployment the owner paid gas for.
    const blind: TreasuryChain = { ...fakeChain({ receipts: { [DEPLOY_TX]: receipt({}) }, deployedWith: deployed }), simulateDeploy: async () => "0x" };
    await expect(check(blind)).rejects.toThrow("The node gave no code for a creation call");
  });

  it("verifies Vestiarion's contract, with its figures", async () => {
    expect(await check(fakeChain({ receipts: { [DEPLOY_TX]: receipt({ from: WALLET.toLowerCase() as Hex }) }, deployedWith: deployed }))).toEqual({
      state: "verified",
      contract: CONTRACT,
      dailyUnits: 50_000_000n,
      weeklyUnits: 150_000_000n,
    });
  });
});

describe("verifyApproval", () => {
  const check = (chain: TreasuryChain, minimumUnits = 1_000_000n) =>
    verifyApproval(chain, { txHash: APPROVE_TX, usdc: USDC, treasury: WALLET, contract: CONTRACT, minimumUnits });
  const approval = (fields: Partial<TreasuryReceipt> = {}) => ({ [APPROVE_TX]: receipt({ to: USDC.toLowerCase() as Hex, contractAddress: null, ...fields }) });

  it("waits while the approval is not mined", async () => {
    expect(await check(fakeChain({ receipts: {} }))).toEqual({ state: "pending" });
  });

  it("refuses one that failed, came from another wallet, was not sent to USDC, or approves less than the minimum", async () => {
    expect((await check(fakeChain({ receipts: approval({ status: "reverted" }), allowance: 10n ** 30n }))).state).toBe("refused");
    expect((await check(fakeChain({ receipts: approval({ from: STRANGER.address }), allowance: 10n ** 30n }))).state).toBe("refused");
    expect((await check(fakeChain({ receipts: approval({ to: CONTRACT }), allowance: 10n ** 30n }))).state).toBe("refused");
    expect((await check(fakeChain({ receipts: approval(), allowance: 999_999n }))).state).toBe("refused");
  });

  it("verifies the approval, with what it allows", async () => {
    expect(await check(fakeChain({ receipts: approval(), allowance: 2n ** 256n - 1n }))).toEqual({ state: "verified", allowanceUnits: 2n ** 256n - 1n });
  });
});

describe("verifyDeployedAt (passkey treasury K7)", () => {
  // A smart account's deployment goes through the bundler and the proxy: there is no receipt naming the contract, so the
  // contract is checked where it is.
  const at = (chain: TreasuryChain, agent: Hex = AGENT) => verifyDeployedAt(chain, { contract: CONTRACT.toLowerCase(), usdc: USDC, treasury: WALLET, agent });

  it("waits while there is no code at the address", async () => {
    expect(await at(fakeChain({ receipts: {} }))).toEqual({ state: "pending" });
  });

  it("refuses code that is not Vestiarion's contract for this wallet and agent", async () => {
    expect(await at(fakeChain({ receipts: {}, deployedWith: deployed }), OTHER_AGENT)).toMatchObject({ state: "refused" });
  });

  it("cannot check where the node simulates no creation", async () => {
    const blind: TreasuryChain = { ...fakeChain({ receipts: {}, deployedWith: deployed }), simulateDeploy: async () => "0x" };
    await expect(at(blind)).rejects.toThrow("The node gave no code for a creation call");
  });

  it("verifies Vestiarion's contract there, with its figures", async () => {
    expect(await at(fakeChain({ receipts: {}, deployedWith: deployed }))).toEqual({ state: "verified", contract: CONTRACT, dailyUnits: 50_000_000n, weeklyUnits: 150_000_000n });
  });
});
