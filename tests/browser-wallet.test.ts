import { describe, expect, it, vi } from "vitest";
import { hexToString } from "viem";
import { connectWallet, discoverWallets, ensureNetwork, sendPrepared, signProof, walletErrorMessage, type Eip1193Provider } from "@/lib/browser-wallet";
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

  it("sends a transaction the server built: no `to` for a deployment, the value in hex", async () => {
    const { wallet, requests } = provider(() => `0x${"d1".repeat(32)}`);
    expect(await sendPrepared(wallet, "0xb0b0", { to: null, data: "0x6080", value: "0", chainId: 5042 })).toBe(`0x${"d1".repeat(32)}`);
    expect(requests[0]).toEqual({ method: "eth_sendTransaction", params: [{ from: "0xb0b0", data: "0x6080", value: "0x0" }] });
    await sendPrepared(wallet, "0xb0b0", { to: "0xa9e7", data: "0x", value: "500000000000000000", chainId: 5042 });
    expect(requests[1]).toEqual({ method: "eth_sendTransaction", params: [{ from: "0xb0b0", to: "0xa9e7", data: "0x", value: "0x6f05b59d3b20000" }] });
  });

  it("says plainly when the person declined in their wallet", () => {
    expect(walletErrorMessage(Object.assign(new Error("User rejected the request."), { code: 4001 }))).toBe("You declined it in your wallet.");
    expect(walletErrorMessage(new Error("insufficient funds for gas"))).toBe("Your wallet did not send it: insufficient funds for gas");
  });
});
