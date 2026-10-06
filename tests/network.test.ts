import { describe, expect, it } from "vitest";
import { ARC_MAINNET, ARC_TESTNET, networkOf, networkProfile, NETWORKS } from "@/lib/network";
import { GATEWAY_FACILITATOR_URL, X402_NETWORK } from "@/lib/x402/offer";
import { addressUrl, txUrl } from "@/lib/payee-chains";

/**
 * One profile per network (docs/superpowers/specs/2026-10-05-network-foundation-design.md N6): each network's facts in
 * one place. Today's Arc testnet constants read their values from the testnet profile, unchanged.
 */

describe("the Arc testnet profile", () => {
  it("holds the values every module used before it", () => {
    expect(ARC_TESTNET).toEqual({
      id: "arc-testnet",
      label: "Arc testnet",
      circleBlockchain: "ARC-TESTNET",
      chainId: 5042002,
      caip2: "eip155:5042002",
      rpcUrl: "https://rpc.testnet.arc.network",
      explorer: "https://explorer.testnet.arc.io",
      tokens: { USDC: "0x3600000000000000000000000000000000000000", EURC: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" },
      payeeChains: ARC_TESTNET.payeeChains,
      cctp: { domain: 26, iris: "https://iris-api-sandbox.circle.com", tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" },
      gateway: {
        api: "https://gateway-api-testnet.circle.com/v1",
        facilitator: "https://gateway-api-testnet.circle.com",
        wallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
        minter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
      },
      usyc: {
        token: "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C",
        teller: "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A",
        entitlements: "0xCC205224862C7641930c87679E98999d23C26113",
      },
      stablecoinServiceChain: "Arc_Testnet",
      swapAdapter: "0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b",
      hostedWallets: true,
      circleKeyPrefix: "TEST_API_KEY:",
      modularWallets: { chain: "arcTestnet" },
      // Sponsored smart accounts, and every contract feature (mainnet go-live M6, M7).
      walletAccountType: "SCA",
      gasReserveUsdc: 0,
      escrow: true,
      spendingLimitContract: true,
      usdcIsNative: true,
    });
  });

  it("is where links, payee chains and the platform's x402 offer read Arc testnet's values", () => {
    expect(txUrl("arc-testnet", "0xabc")).toBe(`${ARC_TESTNET.explorer}/tx/0xabc`);
    expect(addressUrl("arc-testnet", "0xdef")).toBe(`${ARC_TESTNET.explorer}/address/0xdef`);
    expect(ARC_TESTNET.payeeChains[0]).toMatchObject({ id: ARC_TESTNET.circleBlockchain, label: ARC_TESTNET.label, domain: ARC_TESTNET.cctp.domain });
    expect(GATEWAY_FACILITATOR_URL).toBe(ARC_TESTNET.gateway.facilitator);
    expect(X402_NETWORK).toBe(ARC_TESTNET.caip2);
  });
});

describe("the Arc mainnet profile", () => {
  it("holds Arc mainnet's facts as read on 2026-10-04, with what is not verified there off", () => {
    expect(ARC_MAINNET).toEqual({
      id: "arc-mainnet",
      label: "Arc mainnet",
      circleBlockchain: "ARC",
      chainId: 5042,
      caip2: "eip155:5042",
      rpcUrl: "https://rpc.mainnet.arc.io",
      explorer: "https://explorer.arc.io",
      tokens: { USDC: "0x3600000000000000000000000000000000000000", EURC: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1" },
      payeeChains: ARC_MAINNET.payeeChains,
      cctp: null,
      gateway: null,
      usyc: null,
      stablecoinServiceChain: null,
      swapAdapter: null,
      hostedWallets: false,
      circleKeyPrefix: "LIVE_API_KEY:",
      modularWallets: null,
      // EOAs that pay their own gas in USDC, and no per-workspace contract yet (mainnet go-live M6, M7).
      walletAccountType: "EOA",
      gasReserveUsdc: 0.1,
      escrow: false,
      spendingLimitContract: false,
      usdcIsNative: true,
    });
  });
});

describe("a network's id", () => {
  it("names one of the two profiles", () => {
    expect(Object.keys(NETWORKS)).toEqual(["arc-testnet", "arc-mainnet"]);
    expect(networkProfile("arc-mainnet")).toBe(ARC_MAINNET);
  });

  it("reads a missing one as Arc testnet, and refuses anything else rather than guess", () => {
    expect(networkOf(undefined)).toBe("arc-testnet");
    expect(networkOf(null)).toBe("arc-testnet");
    expect(networkOf("arc-mainnet")).toBe("arc-mainnet");
    expect(() => networkOf("arc-sepolia")).toThrow('"arc-sepolia" is not a network Vestiarion knows');
  });
});
