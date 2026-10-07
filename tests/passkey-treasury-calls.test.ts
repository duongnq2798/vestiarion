import { describe, expect, it } from "vitest";
import { concat, decodeFunctionData, erc20Abi, getAddress, getContractAddress, keccak256, maxUint256, parseEther, stringToHex, type Hex } from "viem";
import { ARC_MAINNET } from "@/lib/network";
import { checkPasskeySetup, DEPLOYMENT_PROXY, passkeySetupCalls, spendingLimitSalt } from "@/lib/passkey-treasury";
import { deploymentData } from "@/lib/spending-limit/deployment";

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
const input = { usdc: USDC, treasury: WALLET, agent: AGENT, dailyUnits: 50_000_000n, weeklyUnits: 150_000_000n, capUnits: null, salt: SALT, deployed: false, gasWei: GAS };
const code = deploymentData({ usdc: USDC, treasury: WALLET, agent: AGENT, dailyUnits: 50_000_000n, weeklyUnits: 150_000_000n });
const CONTRACT = getContractAddress({ opcode: "CREATE2", from: DEPLOYMENT_PROXY, salt: SALT, bytecode: code });

describe("spendingLimitSalt", () => {
  it("is the workspace's own, so its contract's address is known before anything is sent", () => {
    expect(SALT).toBe(keccak256(stringToHex(`vestiarion:spending-limit:${ORG}`)));
    expect(spendingLimitSalt("another-org")).not.toBe(SALT);
  });
});

describe("passkeySetupCalls", () => {
  it("deploys the contract through the proxy, approves it without a cap, and sends the agent its gas", () => {
    const { contract, calls } = passkeySetupCalls(input);
    expect(contract).toBe(CONTRACT);
    expect(DEPLOYMENT_PROXY).toBe("0x4e59b44847b379578588920cA78FbF26c0b4956C");
    expect(calls).toEqual([
      { to: DEPLOYMENT_PROXY, data: concat([SALT, code]), value: 0n },
      { to: USDC, data: expect.any(String), value: 0n },
      { to: AGENT, data: "0x", value: GAS },
    ]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[1].data }).args).toEqual([CONTRACT, maxUint256]);
  });

  it("approves only the cap, where one is set", () => {
    const { calls } = passkeySetupCalls({ ...input, capUnits: 250_000_000n });
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[1].data }).args).toEqual([CONTRACT, 250_000_000n]);
  });

  it("leaves the deployment out where the contract is there already (Review Focus 2)", () => {
    const { contract, calls } = passkeySetupCalls({ ...input, deployed: true });
    expect(contract).toBe(CONTRACT);
    expect(calls.map((call) => call.to)).toEqual([USDC, AGENT]);
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
    const [deploy, approve, gas] = expected.calls;
    const thief = getAddress("0x00000000000000000000000000000000000bad00");
    const variants = [
      [deploy, { ...approve, to: thief }, gas],
      [deploy, { ...approve, data: encodeTransfer(thief) }, gas],
      [deploy, approve, { ...gas, value: parseEther("50") }],
      [deploy, approve, gas, { to: USDC, data: encodeTransfer(thief), value: 0n }],
      [approve, gas],
    ];
    for (const calls of variants) expect(() => checkPasskeySetup(sent(calls), expected)).toThrow(MISMATCH);
    expect(() => checkPasskeySetup(sent(expected.calls, thief), expected)).toThrow(MISMATCH);
  });
});

function encodeTransfer(to: Hex): Hex {
  return `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${(1_000_000n).toString(16).padStart(64, "0")}` as Hex;
}
