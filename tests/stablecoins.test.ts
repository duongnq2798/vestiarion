import { describe, expect, it } from "vitest";
import { stablecoinEntry, stablecoinOf } from "@/lib/circle/stablecoins";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";

/**
 * A stablecoin is chosen by its contract, never by its symbol (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md
 * M7). Circle lists two "USDC" entries for every Arc wallet, and anyone can deploy a token named "USDC".
 */

/** As Circle listed an Arc testnet wallet on 2026-10-06: the native token first, then the ERC-20 at 0x3600…. */
const NATIVE = { token: { id: "usdc-native", symbol: "USDC", tokenAddress: null, isNative: true }, amount: "13" };
const ERC20 = { token: { id: "usdc-erc20", symbol: "USDC", tokenAddress: "0x3600000000000000000000000000000000000000", isNative: false }, amount: "13" };
const EURC = { token: { id: "eurc", symbol: "EURC", tokenAddress: ARC_TESTNET.tokens.EURC.toLowerCase(), isNative: false }, amount: "2" };
const FAKE_USDC = { token: { id: "spoof", symbol: "USDC", tokenAddress: "0x1111111111111111111111111111111111111111", isNative: false }, amount: "1000000" };
const FAKE_EURC = { token: { id: "spoof-eurc", symbol: "EURC", tokenAddress: "0x2222222222222222222222222222222222222222", isNative: false }, amount: "500" };

describe("stablecoinOf (mainnet go-live M7)", () => {
  it("knows Arc's native token and the ERC-20 at the profile's address as USDC", () => {
    expect(stablecoinOf(NATIVE.token, ARC_TESTNET)).toBe("USDC");
    expect(stablecoinOf(ERC20.token, ARC_TESTNET)).toBe("USDC");
    expect(stablecoinOf(ERC20.token, ARC_MAINNET)).toBe("USDC");
    expect(stablecoinOf(NATIVE.token, ARC_MAINNET)).toBe("USDC");
  });

  it("knows EURC only at the network's own EURC address", () => {
    expect(stablecoinOf(EURC.token, ARC_TESTNET)).toBe("EURC");
    expect(stablecoinOf(EURC.token, ARC_MAINNET)).toBeNull();
    expect(stablecoinOf({ id: "eurc-main", symbol: "EURC", tokenAddress: ARC_MAINNET.tokens.EURC, isNative: false }, ARC_MAINNET)).toBe("EURC");
  });

  it("ignores a token that only calls itself USDC or EURC", () => {
    expect(stablecoinOf(FAKE_USDC.token, ARC_TESTNET)).toBeNull();
    expect(stablecoinOf(FAKE_EURC.token, ARC_TESTNET)).toBeNull();
    expect(stablecoinOf({ id: "bare", symbol: "USDC" }, ARC_TESTNET)).toBeNull();
    expect(stablecoinOf(undefined, ARC_TESTNET)).toBeNull();
  });
});

describe("stablecoinEntry (M7)", () => {
  it("sends USDC as the ERC-20 whichever entry Circle lists first, so a payee that is a contract is paid (mainnet pre-flight)", () => {
    // Native value sent to a contract is not guaranteed to arrive; the ERC-20's transfer() never calls the recipient.
    for (const network of [ARC_TESTNET, ARC_MAINNET]) {
      expect(stablecoinEntry([NATIVE, ERC20], "USDC", network)?.token.id, network.id).toBe("usdc-erc20");
      expect(stablecoinEntry([ERC20, NATIVE], "USDC", network)?.token.id, network.id).toBe("usdc-erc20");
    }
  });

  it("falls back to the native entry when Circle lists no ERC-20", () => {
    expect(stablecoinEntry([NATIVE], "USDC", ARC_TESTNET)?.token.id).toBe("usdc-native");
    expect(stablecoinEntry([NATIVE], "USDC", ARC_MAINNET)?.token.id).toBe("usdc-native");
  });

  it("passes over a spoof listed first", () => {
    expect(stablecoinEntry([FAKE_USDC, NATIVE], "USDC", ARC_TESTNET)?.token.id).toBe("usdc-native");
    expect(stablecoinEntry([FAKE_EURC, EURC], "EURC", ARC_TESTNET)?.token.id).toBe("eurc");
    expect(stablecoinEntry([FAKE_USDC], "USDC", ARC_TESTNET)).toBeUndefined();
    expect(stablecoinEntry(undefined, "USDC", ARC_TESTNET)).toBeUndefined();
  });
});

describe("a wallet on another of the network's chains (final review I1)", () => {
  const ETH = { token: { id: "eth", symbol: "ETH-SEPOLIA", tokenAddress: null, isNative: true }, amount: "0.25" };
  const BASE_USDC = { token: { id: "usdc-base", symbol: "USDC", tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", isNative: false }, amount: "6200" };

  it("knows USDC only at that chain's own USDC address, never its native token", () => {
    expect(stablecoinOf(ETH.token, ARC_TESTNET, "BASE-SEPOLIA")).toBeNull();
    expect(stablecoinOf(BASE_USDC.token, ARC_TESTNET, "BASE-SEPOLIA")).toBe("USDC");
    expect(stablecoinOf(ERC20.token, ARC_TESTNET, "BASE-SEPOLIA")).toBeNull();
    expect(stablecoinOf(EURC.token, ARC_TESTNET, "BASE-SEPOLIA")).toBeNull();
    expect(stablecoinEntry([ETH, BASE_USDC], "USDC", ARC_TESTNET, "BASE-SEPOLIA")?.token.id).toBe("usdc-base");
  });

  it("reads the home chain as before, by default and by name", () => {
    expect(stablecoinEntry([NATIVE, ERC20], "USDC", ARC_TESTNET, "ARC-TESTNET")?.token.id).toBe("usdc-erc20");
    expect(stablecoinOf(BASE_USDC.token, ARC_TESTNET)).toBeNull();
  });

  it("knows nothing on a chain the network does not pay on", () => {
    expect(stablecoinOf(NATIVE.token, ARC_MAINNET, "ARC-TESTNET")).toBeNull();
    expect(stablecoinOf(BASE_USDC.token, ARC_MAINNET, "BASE-SEPOLIA")).toBeNull();
  });
});
