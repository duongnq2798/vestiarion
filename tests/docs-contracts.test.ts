import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ARC_TESTNET } from "@/lib/network";
import { addressUrl } from "@/lib/payee-chains";

/**
 * The contract addresses the docs and the README publish are the ones the code calls, so neither goes stale when
 * an address changes in code, and each links where the app links an address on Arc. The deployed copies of
 * Vestiarion's own contracts are production data, not code: they are checked here only for their shape and their
 * Arcscan links.
 */

const ROOT = process.cwd();
const PAGE = readFileSync(path.join(ROOT, "content", "docs", "contracts.mdx"), "utf8");
const README = readFileSync(path.join(ROOT, "README.md"), "utf8");
const ARC_CONTRACTS = [ARC_TESTNET.tokens.USDC, ARC_TESTNET.tokens.EURC, ARC_TESTNET.usyc.token, ARC_TESTNET.usyc.teller, ARC_TESTNET.usyc.entitlements, ARC_TESTNET.gateway.wallet, ARC_TESTNET.gateway.minter, ARC_TESTNET.cctp.tokenMessenger];
const DEPLOYED = ["0x74af203fec3f121ff1cd3a763092d1211487702b", "0x9da3c47f73ea9399ac566806a189b0bf47b7d4ba"];
const arcscan = (address: string) => `](${addressUrl("arc-testnet", address)})`;

describe("Contracts on Arc testnet", () => {
  it.each(ARC_CONTRACTS)("the page and the README link %s, the address the code calls, on Arcscan", (address) => {
    expect(PAGE).toContain(`[\`${address}\`${arcscan(address)}`);
    expect(README).toContain(`[\`${address}\`${arcscan(address)}`);
  });

  it("lists the USDC of every other chain a payee is paid on", () => {
    for (const [chain, address] of ARC_TESTNET.payeeChains.map((entry) => [entry.id, entry.usdc])) {
      if (chain === "ARC-TESTNET") continue;
      expect(PAGE, chain).toContain(address);
    }
  });

  it("links the deployed escrow and spending-limit contracts in both", () => {
    for (const address of DEPLOYED) {
      expect(address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(PAGE).toContain(arcscan(address));
      expect(README).toContain(arcscan(address));
    }
  });

  it("links the spending limit contract deployed on Arc mainnet in both, on Arc mainnet's explorer", () => {
    const mainnet = "0xd90cA89Fc318d0330Bb14eaeF78B72C3CA7E7fB6";
    expect(PAGE).toContain(`[\`${mainnet}\`](${addressUrl("arc-mainnet", mainnet)})`);
    expect(README).toContain(`[\`${mainnet}\`](${addressUrl("arc-mainnet", mainnet)})`);
  });

  it("names the compiler the contracts are built with", () => {
    const settings = JSON.parse(readFileSync(path.join(ROOT, "contracts", "solc-settings.json"), "utf8")) as { evmVersion: string; optimizer: { enabled: boolean; runs: number } };
    for (const file of ["VestiarionEscrow.sol", "VestiarionSpendingLimit.sol"]) {
      expect(readFileSync(path.join(ROOT, "contracts", file), "utf8")).toContain("pragma solidity 0.8.37;");
    }
    expect(PAGE).toContain("Solidity 0.8.37");
    expect(settings.optimizer).toEqual({ enabled: true, runs: 200 });
    expect(PAGE).toContain("the optimizer on at 200 runs");
    expect(PAGE).toContain(`for the \`${settings.evmVersion}\` EVM version`);
  });

  it("describes only functions and events the contracts have", () => {
    const escrow = readFileSync(path.join(ROOT, "contracts", "VestiarionEscrow.sol"), "utf8");
    const limit = readFileSync(path.join(ROOT, "contracts", "VestiarionSpendingLimit.sol"), "utf8");
    for (const name of ["function fund(", "function release(", "function refund(", "event Funded(", "event Released(", "event Refunded("]) expect(escrow).toContain(name);
    for (const name of ["function pay(", "function setLimits(", "function spentToday(", "function spentThisWeek(", "event Paid(", "event LimitsSet("]) expect(limit).toContain(name);
  });
});
