import { describe, expect, it } from "vitest";
import { addressOnChainUrl, addressUrl, ChainNotOnNetworkError, chainsOn, txUrl, chainOn } from "@/lib/payee-chains";
import { NETWORK_IDS, type PayeeChainEntry } from "@/lib/network";

/**
 * Links to Arc open on Arc's own explorer, explorer.testnet.arc.io (docs.arc.io names it as Arc testnet's explorer;
 * testnet.arcscan.app only redirects there). The app, the Telegram and Slack messages, the payment emails and the
 * GitHub comments all build their links here, so the explorer is named in one place.
 */

const TX = `0x${"ab".repeat(32)}`;
const USDC = "0x3600000000000000000000000000000000000000";

describe("links to Arc's explorer", () => {
  it("opens a transaction at its hash", () => {
    expect(txUrl("arc-testnet", TX)).toBe(`https://explorer.testnet.arc.io/tx/${TX}`);
  });

  it("opens a wallet or a contract at its address", () => {
    expect(addressUrl("arc-testnet", USDC)).toBe("https://explorer.testnet.arc.io/address/0x3600000000000000000000000000000000000000");
  });

  it("gives Arc testnet, among the chains a payee is paid on, the same transaction link", () => {
    expect(`${chainOn("arc-testnet", "ARC-TESTNET").explorerTx}${TX}`).toBe(`https://explorer.testnet.arc.io/tx/${TX}`);
  });
});

/**
 * A payee's address on the explorer of the chain it is paid on (docs/superpowers/specs/2026-11-09-counterparty-page-design.md
 * CL5): a counterparty's page links it, and never shortens it.
 */
describe("a payee's address on its chain's explorer", () => {
  const ADDRESS = "0x8F3a6b1C2d4E5f60718293a4B5c6D7e8F9012345";

  it("CL5: links the address on every chain a payee is paid on, on both networks", () => {
    const links = Object.fromEntries(NETWORK_IDS.flatMap((network) => chainsOn(network).map((chain) => [chain.id, addressOnChainUrl(chain, ADDRESS)])));
    expect(links).toEqual({
      "ARC-TESTNET": `https://explorer.testnet.arc.io/address/${ADDRESS}`,
      "BASE-SEPOLIA": `https://sepolia.basescan.org/address/${ADDRESS}`,
      "ARB-SEPOLIA": `https://sepolia.arbiscan.io/address/${ADDRESS}`,
      "ETH-SEPOLIA": `https://sepolia.etherscan.io/address/${ADDRESS}`,
      ARC: `https://explorer.arc.io/address/${ADDRESS}`,
      BASE: `https://basescan.org/address/${ADDRESS}`,
      ARB: `https://arbiscan.io/address/${ADDRESS}`,
    });
  });

  it("CL5: gives Arc's own chain the same link as the network's explorer", () => {
    for (const network of NETWORK_IDS) expect(addressOnChainUrl(chainsOn(network)[0], ADDRESS)).toBe(addressUrl(network, ADDRESS));
  });

  it("CL5: makes no link of anything but 0x and 40 hex digits", () => {
    const chain = chainOn("arc-testnet", "ARC-TESTNET");
    for (const address of ["", "vitalik.eth", ADDRESS.slice(0, -1), `${ADDRESS}0`, `${ADDRESS.slice(0, -1)}g`, `0X${ADDRESS.slice(2)}`, ` ${ADDRESS}`, `${ADDRESS}/../tx`, `${ADDRESS}#x`]) {
      expect(addressOnChainUrl(chain, address), address).toBeNull();
    }
    expect(addressOnChainUrl(chain, ADDRESS.toLowerCase())).toBe(`https://explorer.testnet.arc.io/address/${ADDRESS.toLowerCase()}`);
  });

  it("CL5: makes no link on a chain whose transaction link does not end in /tx/", () => {
    const odd: PayeeChainEntry = { ...chainOn("arc-testnet", "ARC-TESTNET"), explorerTx: "https://explorer.example/transaction?hash=" };
    expect(addressOnChainUrl(odd, ADDRESS)).toBeNull();
  });

  it("CL5: refuses another network's chain, which the page says it does not pay on", () => {
    expect(() => chainOn("arc-mainnet", "BASE-SEPOLIA")).toThrow(ChainNotOnNetworkError);
    expect(() => chainOn("arc-testnet", "BASE")).toThrow(ChainNotOnNetworkError);
    expect(() => chainOn("arc-testnet", "SOLANA")).toThrow(ChainNotOnNetworkError);
  });
});
