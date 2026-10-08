import { describe, expect, it, vi } from "vitest";
import { hexToString } from "viem";
import {
  connectWallet,
  discoverWallets,
  ensureNetwork,
  erc20Allowance,
  erc20Balance,
  sendPrepared,
  signProof,
  switchChain,
  waitForReceipt,
  walletErrorMessage,
  type Eip1193Provider,
} from "@/lib/browser-wallet";
import { ARC_MAINNET } from "@/lib/network";

/**
 * The owner's wallet in their browser (docs/superpowers/specs/2026-10-07-wallet-treasury-design.md W3, W7): found as
 * EIP-6963 announces it, or as `window.ethereum`; switched to the workspace's network, which it is taught when it does
 * not know it; and asked to sign a proof and send the transactions the server built, nothing else.
 */

type Request = { method: string; params?: unknown };

function provider(answer: (request: Request) => unknown | Promise<unknown>) {
  const requests: Request[] = [];
  const wallet: Eip1193Provider = {
    request: vi.fn(async (request: Request) => {
      requests.push(request);
      return answer(request);
    }),
  };
  return { wallet, requests };
}

/** A window that answers EIP-6963's request with the wallets given, as extensions do. */
function windowWith(announced: Array<{ uuid: string; name: string; rdns: string; provider: Eip1193Provider }>, ethereum?: Eip1193Provider) {
  const target = new EventTarget();
  target.addEventListener("eip6963:requestProvider", () => {
    for (const wallet of announced) {
      const event = new Event("eip6963:announceProvider") as Event & { detail: unknown };
      event.detail = { info: { uuid: wallet.uuid, name: wallet.name, icon: "data:image/svg+xml,", rdns: wallet.rdns }, provider: wallet.provider };
      target.dispatchEvent(event);
    }
  });
  return Object.assign(target, { ethereum });
}

describe("discoverWallets", () => {
  it("lists the wallets the browser announces, once each", async () => {
    const metamask = provider(() => null).wallet;
    const rabby = provider(() => null).wallet;
    const found = await discoverWallets(
      windowWith([
        { uuid: "1", name: "MetaMask", rdns: "io.metamask", provider: metamask },
        { uuid: "2", name: "Rabby", rdns: "io.rabby", provider: rabby },
        { uuid: "1", name: "MetaMask", rdns: "io.metamask", provider: metamask },
      ]),
      10
    );
    expect(found.map((wallet) => wallet.name)).toEqual(["MetaMask", "Rabby"]);
  });

  it("falls back to window.ethereum when nothing announces itself, and finds nothing without it", async () => {
    const injected = provider(() => null).wallet;
    expect((await discoverWallets(windowWith([], injected), 10)).map((wallet) => wallet.name)).toEqual(["Browser wallet"]);
    expect(await discoverWallets(windowWith([]), 10)).toEqual([]);
  });
});

describe("the owner's wallet", () => {
  it("shares its first account", async () => {
    const { wallet } = provider((request) => (request.method === "eth_requestAccounts" ? ["0xB0B0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"] : null));
    expect(await connectWallet(wallet)).toBe("0xB0B0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0");
  });

  it("switches to the workspace's network, and adds it first when the wallet does not know it", async () => {
    const known = provider(() => null);
    await ensureNetwork(known.wallet, ARC_MAINNET);
    expect(known.requests).toEqual([{ method: "wallet_switchEthereumChain", params: [{ chainId: "0x13b2" }] }]);

    let added = false;
    const unknown = provider((request) => {
      if (request.method === "wallet_addEthereumChain") {
        added = true;
        return null;
      }
      if (!added) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
      return null;
    });
    await ensureNetwork(unknown.wallet, ARC_MAINNET);
    expect(unknown.requests.map((request) => request.method)).toEqual(["wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_switchEthereumChain"]);
    expect(unknown.requests[1].params).toEqual([
      {
        chainId: "0x13b2",
        chainName: "Arc mainnet",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: ["https://rpc.mainnet.arc.io"],
        blockExplorerUrls: ["https://explorer.arc.io"],
      },
    ]);
  });

  it("signs the proof as personal_sign, the message in hex", async () => {
    const { wallet, requests } = provider(() => "0x51");
    expect(await signProof(wallet, "0xb0b0", "Vestiarion: pay from this wallet")).toBe("0x51");
    const [hex, address] = requests[0].params as [`0x${string}`, string];
    expect(requests[0].method).toBe("personal_sign");
    expect(hexToString(hex)).toBe("Vestiarion: pay from this wallet");
    expect(address).toBe("0xb0b0");
  });

  it("sends a transaction the server built, on its chain: no `to` for a deployment, the value in hex", async () => {
    const { wallet, requests } = provider((request) => (request.method === "eth_chainId" ? "0x13b2" : `0x${"d1".repeat(32)}`));
    expect(await sendPrepared(wallet, "0xb0b0", { to: null, data: "0x6080", value: "0", chainId: 5042 })).toBe(`0x${"d1".repeat(32)}`);
    expect(requests[0]).toEqual({ method: "eth_chainId" });
    expect(requests[1]).toEqual({ method: "eth_sendTransaction", params: [{ from: "0xb0b0", data: "0x6080", value: "0x0", chainId: "0x13b2" }] });
    await sendPrepared(wallet, "0xb0b0", { to: "0xa9e7", data: "0x", value: "500000000000000000", chainId: 5042 });
    expect(requests[3]).toEqual({ method: "eth_sendTransaction", params: [{ from: "0xb0b0", to: "0xa9e7", data: "0x", value: "0x6f05b59d3b20000", chainId: "0x13b2" }] });
  });

  it("sends nothing when the wallet has moved to another chain since it was switched", async () => {
    // 0.50 of Arc's USDC is 0.5 of another chain's own currency: the same value must never leave there.
    const { wallet, requests } = provider((request) => (request.method === "eth_chainId" ? "0x1" : `0x${"d1".repeat(32)}`));
    await expect(sendPrepared(wallet, "0xb0b0", { to: "0xa9e7", data: "0x", value: "500000000000000000", chainId: 5042 })).rejects.toThrow(
      "Your wallet is on another network now. Choose the step again: it switches to the workspace's network first."
    );
    expect(requests.map((request) => request.method)).toEqual(["eth_chainId"]);
  });

  it("says plainly when the person declined in their wallet", () => {
    expect(walletErrorMessage(Object.assign(new Error("User rejected the request."), { code: 4001 }))).toBe("You declined it in your wallet.");
    expect(walletErrorMessage(new Error("insufficient funds for gas"))).toBe("Your wallet did not send it: insufficient funds for gas");
  });
});

describe("the wallet on another chain (add USDC B3, B4)", () => {
  const BASE = { chainId: 8453, label: "Base", rpcUrl: "https://mainnet.base.org", explorer: "https://basescan.org", nativeSymbol: "ETH" };

  it("switches to a chain, teaching the wallet its own currency when it does not know it", async () => {
    let added = false;
    const unknown = provider((request) => {
      if (request.method === "wallet_addEthereumChain") {
        added = true;
        return null;
      }
      if (!added) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
      return null;
    });
    await switchChain(unknown.wallet, BASE);
    expect(unknown.requests[0]).toEqual({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] });
    expect(unknown.requests[1].params).toEqual([
      { chainId: "0x2105", chainName: "Base", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] },
    ]);
    expect(unknown.requests).toHaveLength(3);
  });

  it("passes on any refusal other than an unknown chain", async () => {
    const declined = provider(() => {
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    });
    await expect(switchChain(declined.wallet, BASE)).rejects.toMatchObject({ code: 4001 });
    expect(declined.requests).toHaveLength(1);
  });

  it("reads an ERC-20 balance and allowance with eth_call on the chain it is on", async () => {
    const owner = "0x" + "b0".repeat(20);
    const spender = "0x" + "28".repeat(20);
    const { wallet, requests } = provider((request) => {
      const [call] = request.params as [{ to: string; data: string }];
      return call.data.startsWith("0x70a08231") ? `0x${(25_500_000).toString(16).padStart(64, "0")}` : `0x${"0".repeat(64)}`;
    });
    expect(await erc20Balance(wallet, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", owner)).toBe(BigInt(25_500_000));
    expect(await erc20Allowance(wallet, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", owner, spender)).toBe(BigInt(0));
    expect(requests[0]).toEqual({ method: "eth_call", params: [{ to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", data: `0x70a08231${"0".repeat(24)}${"b0".repeat(20)}` }, "latest"] });
    expect((requests[1].params as [{ data: string }])[0].data).toBe(`0xdd62ed3e${"0".repeat(24)}${"b0".repeat(20)}${"0".repeat(24)}${"28".repeat(20)}`);
  });

  it("waits for a receipt: confirmed, refused, or not yet after its tries", async () => {
    const sleep = vi.fn(async () => {});
    let asked = 0;
    const later = provider(() => (++asked < 3 ? null : { status: "0x1" }));
    expect(await waitForReceipt(later.wallet, "0xabc", { tries: 5, waitMs: 2000, sleep })).toBe("success");
    expect(later.requests).toEqual([
      { method: "eth_getTransactionReceipt", params: ["0xabc"] },
      { method: "eth_getTransactionReceipt", params: ["0xabc"] },
      { method: "eth_getTransactionReceipt", params: ["0xabc"] },
    ]);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(await waitForReceipt(provider(() => ({ status: "0x0" })).wallet, "0xabc", { tries: 5, waitMs: 1, sleep })).toBe("reverted");
    expect(await waitForReceipt(provider(() => null).wallet, "0xabc", { tries: 3, waitMs: 1, sleep })).toBe("pending");
  });
});
