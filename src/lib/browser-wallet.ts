import { toHex } from "viem";
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

/** Switches the wallet to the workspace's network, adding it first when the wallet does not know it (EIP-3085, 3326). */
export async function ensureNetwork(provider: Eip1193Provider, network: Pick<NetworkProfile, "chainId" | "label" | "rpcUrl" | "explorer">): Promise<void> {
  const chainId = `0x${network.chainId.toString(16)}`;
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
        chainName: network.label,
        // Arc's native currency is USDC, in 18 decimals.
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: [network.rpcUrl],
        blockExplorerUrls: [network.explorer],
      },
    ],
  });
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
}

/** The wallet's signature of the proof message (EIP-191 personal_sign), the message given in hex. */
export async function signProof(provider: Eip1193Provider, address: string, message: string): Promise<string> {
  const signature = await provider.request({ method: "personal_sign", params: [toHex(message), address] });
  if (typeof signature !== "string") throw new Error("The wallet gave no signature.");
  return signature;
}

/** Sends a transaction the server built, from the owner's wallet; the hash it answers with. */
export async function sendPrepared(provider: Eip1193Provider, from: string, tx: { to: string | null; data: string; value: string; chainId: number }): Promise<string> {
  const hash = await provider.request({
    method: "eth_sendTransaction",
    params: [{ from, ...(tx.to ? { to: tx.to } : {}), data: tx.data, value: `0x${BigInt(tx.value).toString(16)}` }],
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
