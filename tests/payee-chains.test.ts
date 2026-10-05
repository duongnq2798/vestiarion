import { describe, expect, it } from "vitest";
import { addressUrl, txUrl, chainOn } from "@/lib/payee-chains";

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
