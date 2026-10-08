import { decodeFunctionResult, encodeFunctionData, erc20Abi, toHex } from "viem";
import type { NetworkProfile } from "./network";

/**
 * The owner's wallet in their browser (docs/superpowers/specs/2026-10-07-wallet-treasury-design.md W3, W7): found as
 * EIP-6963 announces it, or as `window.ethereum`; switched to the workspace's network; and asked to sign a proof and
 * send the transactions the server built, nothing else. It runs in the browser and holds no secret: the wallet signs.
 */

/** A wallet as EIP-1193 has it: one `request` method. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export interface DiscoveredWallet {
  id: string;
  name: string;
  icon: string | null;
  provider: Eip1193Provider;
}

/** The parts of `window` discovery uses, so a test can stand in for it. */
export type WalletWindow = EventTarget & { ethereum?: Eip1193Provider };

interface Announcement {
  info?: { uuid?: string; name?: string; icon?: string; rdns?: string };
  provider?: Eip1193Provider;
}

/**
 * The wallets the browser announces (EIP-6963), once each, waiting `waitMs` for them; or `window.ethereum` as one
 * "Browser wallet" when none answers; or none.
 */
export function discoverWallets(win: WalletWindow, waitMs = 300): Promise<DiscoveredWallet[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredWallet>();
    const onAnnounce = (event: Event) => {
      const detail = (event as Event & { detail?: Announcement }).detail;
      if (!detail?.provider) return;
      const id = detail.info?.rdns ?? detail.info?.uuid ?? `wallet-${found.size}`;
      if (found.has(id)) return;
      found.set(id, { id, name: detail.info?.name ?? "Browser wallet", icon: detail.info?.icon ?? null, provider: detail.provider });
    };
    win.addEventListener("eip6963:announceProvider", onAnnounce);
    win.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      win.removeEventListener("eip6963:announceProvider", onAnnounce);
      const wallets = [...found.values()];
      if (wallets.length === 0 && win.ethereum) wallets.push({ id: "injected", name: "Browser wallet", icon: null, provider: win.ethereum });
      resolve(wallets);
    }, waitMs);
  });
}

/** The account the wallet shares first: the one its owner chose. */
export async function connectWallet(provider: Eip1193Provider): Promise<string> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as unknown;
  const first = Array.isArray(accounts) ? accounts[0] : null;
  if (typeof first !== "string") throw new Error("The wallet shared no account.");
  return first;
}

const errorCode = (error: unknown) => (typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined);

/** A chain a wallet is switched to: its id, its name, an RPC and an explorer the wallet is taught when it does not know it. */
export interface WalletChain {
  chainId: number;
  label: string;
  rpcUrl: string;
  explorer: string;
  /** The chain's own currency, its gas: "ETH" on Base, "USDC" on Arc. */
  nativeSymbol: string;
}

/** Switches the wallet to a chain, adding it first when the wallet does not know it (EIP-3085, 3326). */
export async function switchChain(provider: Eip1193Provider, chain: WalletChain): Promise<void> {
  const chainId = `0x${chain.chainId.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    return;
  } catch (error) {
    if (errorCode(error) !== 4902) throw error;
  }
  await provider.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId,
        chainName: chain.label,
        // EVM chains count their own currency in 18 decimals, Arc's USDC included.
        nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
        rpcUrls: [chain.rpcUrl],
        blockExplorerUrls: [chain.explorer],
      },
    ],
  });
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
}

/** Switches the wallet to the workspace's network, whose own currency is USDC. */
export async function ensureNetwork(provider: Eip1193Provider, network: Pick<NetworkProfile, "chainId" | "label" | "rpcUrl" | "explorer">): Promise<void> {
  await switchChain(provider, { chainId: network.chainId, label: network.label, rpcUrl: network.rpcUrl, explorer: network.explorer, nativeSymbol: "USDC" });
}

/** A view call on the chain the wallet is on, through the wallet's own RPC. */
async function call(provider: Eip1193Provider, to: string, data: string): Promise<`0x${string}`> {
  const answer = await provider.request({ method: "eth_call", params: [{ to, data }, "latest"] });
  if (typeof answer !== "string" || !answer.startsWith("0x")) throw new Error("The wallet could not read the chain.");
  return answer as `0x${string}`;
}

/** An ERC-20 balance, in the token's base units, on the chain the wallet is on. */
export async function erc20Balance(provider: Eip1193Provider, token: string, owner: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner as `0x${string}`] });
  return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: await call(provider, token, data) });
}

/** What `spender` may move of `owner`'s ERC-20, in base units, on the chain the wallet is on. */
export async function erc20Allowance(provider: Eip1193Provider, token: string, owner: string, spender: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [owner as `0x${string}`, spender as `0x${string}`] });
  return decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: await call(provider, token, data) });
}

/**
 * A transaction's receipt, asked of the wallet's chain up to `tries` times, `waitMs` apart: "success" or "reverted" once
 * the chain has it, "pending" when it has not shown it by the last try.
 */
export async function waitForReceipt(
  provider: Eip1193Provider,
  hash: string,
  options: { tries: number; waitMs: number; sleep?: (ms: number) => Promise<void> }
): Promise<"success" | "reverted" | "pending"> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < options.tries; attempt += 1) {
    if (attempt > 0) await sleep(options.waitMs);
    const receipt = (await provider.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status?: unknown } | null;
    if (receipt && typeof receipt.status === "string") return BigInt(receipt.status) === BigInt(1) ? "success" : "reverted";
  }
  return "pending";
}

/** The wallet's signature of the proof message (EIP-191 personal_sign), the message given in hex. */
export async function signProof(provider: Eip1193Provider, address: string, message: string): Promise<string> {
  const signature = await provider.request({ method: "personal_sign", params: [toHex(message), address] });
  if (typeof signature !== "string") throw new Error("The wallet gave no signature.");
  return signature;
}

/**
 * Sends a transaction the server built, from the owner's wallet, on the chain it was built for; the hash it answers with.
 * The wallet is asked its chain again just before, and the transaction names its chain, so a wallet moved to another
 * network since it was switched sends nothing: the same value there would be another currency.
 */
export async function sendPrepared(provider: Eip1193Provider, from: string, tx: { to: string | null; data: string; value: string; chainId: number }): Promise<string> {
  const chainId = `0x${tx.chainId.toString(16)}`;
  const current = await provider.request({ method: "eth_chainId" });
  if (typeof current !== "string" || BigInt(current) !== BigInt(tx.chainId)) {
    throw new Error("Your wallet is on another network now. Choose the step again: it switches to the workspace's network first.");
  }
  const hash = await provider.request({
    method: "eth_sendTransaction",
    params: [{ from, ...(tx.to ? { to: tx.to } : {}), data: tx.data, value: `0x${BigInt(tx.value).toString(16)}`, chainId }],
  });
  if (typeof hash !== "string") throw new Error("The wallet gave no transaction hash.");
  return hash;
}

/** What a wallet's refusal or failure says, in plain words. */
export function walletErrorMessage(error: unknown): string {
  if (errorCode(error) === 4001) return "You declined it in your wallet.";
  const message = error instanceof Error ? error.message : String(error);
  return `Your wallet did not send it: ${message}`;
}
