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
  it("keeps Circle's order among the real entries, so Arc testnet picks what it picked before", () => {
    expect(stablecoinEntry([NATIVE, ERC20], "USDC", ARC_TESTNET)?.token.id).toBe("usdc-native");
    expect(stablecoinEntry([ERC20, NATIVE], "USDC", ARC_TESTNET)?.token.id).toBe("usdc-erc20");
  });

  it("passes over a spoof listed first", () => {
    expect(stablecoinEntry([FAKE_USDC, NATIVE], "USDC", ARC_TESTNET)?.token.id).toBe("usdc-native");
    expect(stablecoinEntry([FAKE_EURC, EURC], "EURC", ARC_TESTNET)?.token.id).toBe("eurc");
    expect(stablecoinEntry([FAKE_USDC], "USDC", ARC_TESTNET)).toBeUndefined();
    expect(stablecoinEntry(undefined, "USDC", ARC_TESTNET)).toBeUndefined();
  });
});
