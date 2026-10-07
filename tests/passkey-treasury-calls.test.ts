import { describe, expect, it } from "vitest";
import { concat, decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, getContractAddress, keccak256, maxUint256, parseAbi, parseEther, stringToHex, type Hex } from "viem";
import { ARC_MAINNET } from "@/lib/network";
import { checkPasskeySetup, DEPLOYMENT_PROXY, passkeySetupCalls, spendingLimitSalt } from "@/lib/passkey-treasury";
import { deploymentData, setLimitsData } from "@/lib/spending-limit/deployment";

/**
 * A passkey wallet's setup as three calls (docs/superpowers/specs/2026-10-07-passkey-treasury-design.md K6): the contract
 * deployed through the deterministic deployment proxy, its approval on USDC, and the agent's gas. The browser rebuilds
 * them from what it shows and refuses to sign anything else (Review Focus 1), since a passkey prompt shows no
 * transaction.
 */

const USDC = getAddress(ARC_MAINNET.tokens.USDC);
const WALLET = getAddress("0x5af3107a4000000000000000000000000000b0b0");
const AGENT = getAddress("0x5af3107a4000000000000000000000000000a9e7");
const ORG = "6a1f0c2e-8c1b-4f7a-9e6d-0000000000c1";
const SALT = spendingLimitSalt(ORG);
const GAS = parseEther("0.5");
const input = { usdc: USDC, treasury: WALLET, agent: AGENT, dailyUnits: 50_000_000n, weeklyUnits: 150_000_000n, capUnits: null, salt: SALT, deployed: false, agentFunded: false, gasWei: GAS };
// Deployed with fixed figures, so its address does not follow them; the real ones are set in the same confirmation.
const code = deploymentData({ usdc: USDC, treasury: WALLET, agent: AGENT, dailyUnits: 1n, weeklyUnits: 1n });
const CONTRACT = getContractAddress({ opcode: "CREATE2", from: DEPLOYMENT_PROXY, salt: SALT, bytecode: code });
/** Circle's modular smart account's batch (ERC-6900), as `toCircleSmartAccount`'s `encodeCalls` writes it. */
const EXECUTE_BATCH = parseAbi(["function executeBatch((address target, uint256 value, bytes data)[] calls) payable returns (bytes[] returnData)"]);

describe("spendingLimitSalt", () => {
  it("is the workspace's own, so its contract's address is known before anything is sent", () => {
    expect(SALT).toBe(keccak256(stringToHex(`vestiarion:spending-limit:${ORG}`)));
    expect(spendingLimitSalt("another-org")).not.toBe(SALT);
  });
});

describe("passkeySetupCalls", () => {
  it("deploys the contract through the proxy, sets its figures, approves it without a cap, and sends the agent its gas", () => {
    const { contract, calls } = passkeySetupCalls(input);
    expect(contract).toBe(CONTRACT);
    expect(DEPLOYMENT_PROXY).toBe("0x4e59b44847b379578588920cA78FbF26c0B4956C");
    expect(calls).toEqual([
      { to: DEPLOYMENT_PROXY, data: concat([SALT, code]), value: 0n },
      { to: CONTRACT, data: setLimitsData(50_000_000n, 150_000_000n), value: 0n },
      { to: USDC, data: expect.any(String), value: 0n },
      { to: AGENT, data: "0x", value: GAS },
    ]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[2].data }).args).toEqual([CONTRACT, maxUint256]);
  });

  it("encodes as the wallet's one batch, as Circle's smart account does, where viem checks every address strictly", () => {
    // 2026-10-07, the first setup on Arc mainnet: the proxy's address was written with one letter in the wrong case, so
    // its checksum failed here, in the SDK's encodeCalls, and nothing could be signed.
    const { calls } = passkeySetupCalls(input);
    const batch = encodeFunctionData({
      abi: EXECUTE_BATCH,
      functionName: "executeBatch",
      args: [calls.map((call) => ({ data: call.data, target: call.to, value: call.value }))],
    });
    expect(decodeFunctionData({ abi: EXECUTE_BATCH, data: batch }).args[0]).toHaveLength(4);
  });

  it("puts the workspace's contract at one address whatever its figures, so a second setup never deploys another (final review I3)", () => {
    expect(passkeySetupCalls({ ...input, dailyUnits: 20_000_000n, weeklyUnits: 60_000_000n }).contract).toBe(CONTRACT);
  });

  it("sends no gas where the agent holds its own already (final review I3)", () => {
    const { calls } = passkeySetupCalls({ ...input, agentFunded: true });
    expect(calls.map((call) => call.to)).toEqual([DEPLOYMENT_PROXY, CONTRACT, USDC]);
  });

  it("approves only the cap, where one is set", () => {
    const { calls } = passkeySetupCalls({ ...input, capUnits: 250_000_000n });
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[2].data }).args).toEqual([CONTRACT, 250_000_000n]);
  });

  it("leaves the deployment out where the contract is there already (Review Focus 2)", () => {
    const { contract, calls } = passkeySetupCalls({ ...input, deployed: true });
    expect(contract).toBe(CONTRACT);
    expect(calls.map((call) => call.to)).toEqual([CONTRACT, USDC, AGENT]);
  });

  it("takes addresses in any case", () => {
    expect(passkeySetupCalls({ ...input, treasury: WALLET.toLowerCase(), agent: AGENT.toLowerCase() as Hex })).toEqual(passkeySetupCalls(input));
  });
});

describe("checkPasskeySetup (Review Focus 1)", () => {
  const expected = passkeySetupCalls(input);
  const sent = (calls = expected.calls, contract: string = expected.contract) => ({ contract, calls: calls.map((call) => ({ ...call, value: call.value.toString() })) });
  const MISMATCH = "The setup Vestiarion sent is not the one this page expected; nothing was signed.";

  it("passes the calls it would have built itself, in any case", () => {
    expect(() => checkPasskeySetup(sent(expected.calls.map((call) => ({ ...call, to: call.to.toLowerCase() as Hex }))), expected)).not.toThrow();
  });

  it("refuses another target, other data, another amount, a call more or less, and another contract", () => {
    const [deploy, limits, approve, gas] = expected.calls;
    const thief = getAddress("0x00000000000000000000000000000000000bad00");
    const variants = [
      [deploy, limits, { ...approve, to: thief }, gas],
      [deploy, limits, { ...approve, data: encodeTransfer(thief) }, gas],
      [deploy, limits, approve, { ...gas, value: parseEther("50") }],
      [deploy, { ...limits, data: setLimitsData(2n ** 200n, 2n ** 200n) }, approve, gas],
      [deploy, limits, approve, gas, { to: USDC, data: encodeTransfer(thief), value: 0n }],
      [limits, approve, gas],
    ];
    for (const calls of variants) expect(() => checkPasskeySetup(sent(calls), expected)).toThrow(MISMATCH);
    expect(() => checkPasskeySetup(sent(expected.calls, thief), expected)).toThrow(MISMATCH);
  });
});

function encodeTransfer(to: Hex): Hex {
  return `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${(1_000_000n).toString(16).padStart(64, "0")}` as Hex;
}
