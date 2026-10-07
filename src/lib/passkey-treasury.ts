import { concat, encodeFunctionData, erc20Abi, getAddress, getContractAddress, keccak256, maxUint256, stringToHex, type Hex } from "viem";
import type { PasskeyWalletConfig } from "./passkey-wallet";
import { deploymentData } from "./spending-limit/deployment";

/**
 * A passkey wallet as a workspace's treasury on Arc mainnet (docs/superpowers/specs/2026-10-07-passkey-treasury-
 * design.md): a Circle Smart Account owned by the owner's passkey, set up with one confirmation. Browser-safe: it holds
 * no secret, and what runs only in the browser lives in src/lib/passkey-treasury-sdk.ts.
 */

/** Circle's Modular Wallets client URL, the one the Console gives every client key. */
const CIRCLE_CLIENT_URL = "https://modular-sdk.circle.com/v1/rpc/w3s/buidl";

/**
 * The Circle mainnet client key and client URL (K11), from the build's environment; null without a key. A client key is
 * meant for the browser: its allowed domain is what guards it, and it carries no right to move anyone's money.
 */
export function passkeyTreasuryConfig(
  env: { key: string | undefined; url: string | undefined } = {
    key: process.env.NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_KEY,
    url: process.env.NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_URL,
  }
): PasskeyWalletConfig | null {
  const clientKey = env.key?.trim() ?? "";
  if (!clientKey) return null;
  const clientUrl = (env.url?.trim() || CIRCLE_CLIENT_URL).replace(/\/+$/, "");
  return { clientKey, clientUrl };
}

/**
 * The deterministic deployment proxy, at the same address on Arc mainnet as on most EVM chains (checked 2026-10-07): a
 * call of `salt ++ creation code` deploys the code with CREATE2, so the contract's address follows from the two (K6).
 */
export const DEPLOYMENT_PROXY = "0x4e59b44847b379578588920cA78FbF26c0b4956C" as const;

/** The workspace's own salt for its contract: one workspace, one address for given figures (K6). */
export function spendingLimitSalt(orgId: string): Hex {
  return keccak256(stringToHex(`vestiarion:spending-limit:${orgId}`));
}

/** One call of a user operation: its target, its data and its value in wei. */
export interface SetupCall {
  to: Hex;
  data: Hex;
  value: bigint;
}

const checksummed = (address: string) => getAddress(address.toLowerCase());

/**
 * A passkey wallet's setup as one user operation (K6): the contract deployed through the proxy (left out when it is at
 * its address already), its approval on USDC (unlimited, or the cap), and the agent's gas in Arc's native USDC. The
 * server builds it, and the browser builds it again from what it shows the owner before the passkey signs.
 */
export function passkeySetupCalls(input: {
  usdc: string;
  treasury: string;
  agent: string;
  dailyUnits: bigint;
  weeklyUnits: bigint;
  capUnits: bigint | null;
  salt: Hex;
  deployed: boolean;
  gasWei: bigint;
}): { contract: Hex; calls: SetupCall[] } {
  const bytecode = deploymentData({ usdc: input.usdc, treasury: input.treasury, agent: input.agent, dailyUnits: input.dailyUnits, weeklyUnits: input.weeklyUnits });
  const contract = getContractAddress({ opcode: "CREATE2", from: DEPLOYMENT_PROXY, salt: input.salt, bytecode });
  const calls: SetupCall[] = [];
  if (!input.deployed) calls.push({ to: DEPLOYMENT_PROXY, data: concat([input.salt, bytecode]), value: 0n });
  calls.push({
    to: checksummed(input.usdc),
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [contract, input.capUnits ?? maxUint256] }),
    value: 0n,
  });
  calls.push({ to: checksummed(input.agent), data: "0x", value: input.gasWei });
  return { contract, calls };
}

/** The refusal when the server's setup is not the browser's own (Review Focus 1). */
export const SETUP_MISMATCH = "The setup Vestiarion sent is not the one this page expected; nothing was signed.";

/**
 * Refuses a setup that differs in anything from the one the browser built itself (K6, Review Focus 1): its contract,
 * the number of calls, or any call's target, data or value. A passkey prompt shows no transaction, so this is where a
 * wrong one is stopped.
 */
export function checkPasskeySetup(
  server: { contract: string; calls: Array<{ to: string; data: string; value: string | bigint }> },
  expected: { contract: string; calls: SetupCall[] }
): void {
  const same =
    server.contract.toLowerCase() === expected.contract.toLowerCase() &&
    server.calls.length === expected.calls.length &&
    server.calls.every((call, index) => {
      const mine = expected.calls[index];
      return call.to.toLowerCase() === mine.to.toLowerCase() && call.data.toLowerCase() === mine.data.toLowerCase() && BigInt(call.value) === mine.value;
    });
  if (!same) throw new Error(SETUP_MISMATCH);
}
