import { describe, expect, it } from "vitest";
import { bridgeFee, burnCalls, cctpOf } from "@/lib/circle/cctp";
import { gatewayOf } from "@/lib/circle/gateway";
import { batchCalls } from "@/lib/circle/batch";
import { SimulateProvider } from "@/lib/circle/simulateProvider";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";

/**
 * A provider and the Circle modules work on the profile they are given
 * (docs/superpowers/specs/2026-10-05-network-threading-design.md P2, P5).
 */

const PAYEE = "0x840de234Bfc3F66fA380888A0a8204D9487D60d4";
const noRequest = (() => {
  throw new Error("no request expected");
}) as unknown as typeof globalThis.fetch;

describe("the simulated provider", () => {
  it("settles on its network's own chain", async () => {
    expect((await new SimulateProvider(ARC_TESTNET).reconcileTransfer("sim-1")).chain).toBe("ARC-TESTNET");
    expect((await new SimulateProvider(ARC_MAINNET).reconcileTransfer("sim-1")).chain).toBe("ARC");
    expect(new SimulateProvider(ARC_MAINNET).network).toBe(ARC_MAINNET);
  });
});

describe("CCTP and Gateway read the profile", () => {
  it("give Arc testnet's facts, as before", () => {
    expect(cctpOf(ARC_TESTNET)).toEqual({ domain: 26, iris: "https://iris-api-sandbox.circle.com", tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" });
    expect(gatewayOf(ARC_TESTNET).wallet).toBe("0x0077777d7EBA4688BDeF3E311b846F25870A19B9");
  });

  it("refuse by name on a network without them, before any request", async () => {
    expect(() => cctpOf(ARC_MAINNET)).toThrow("Paying through CCTP does not run on Arc mainnet yet");
    expect(() => gatewayOf(ARC_MAINNET)).toThrow("Paying through Gateway does not run on Arc mainnet yet");
    await expect(bridgeFee(ARC_MAINNET, "BASE-SEPOLIA", 1, { fetch: noRequest })).rejects.toThrow("Paying through CCTP does not run on Arc mainnet yet");
  });

  it("burn and batch with the USDC they are given", () => {
    const [approve] = burnCalls({ amount: 1, maxFeeUnits: 10n, domain: 6, recipient: PAYEE, usdc: ARC_TESTNET.tokens.USDC, tokenMessenger: cctpOf(ARC_TESTNET).tokenMessenger });
    expect(approve.contractAddress).toBe(ARC_TESTNET.tokens.USDC);
    const calls = batchCalls([{ toAddress: PAYEE, amount: 1 }, { toAddress: PAYEE, amount: 2 }], ARC_MAINNET.tokens.USDC);
    expect(calls.map(([token]) => token)).toEqual([ARC_MAINNET.tokens.USDC, ARC_MAINNET.tokens.USDC]);
  });
});
