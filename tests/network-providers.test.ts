import { describe, expect, it } from "vitest";
import { bridgeFee, burnCalls, cctpOf } from "@/lib/circle/cctp";
import { gatewayOf } from "@/lib/circle/gateway";
import { batchCalls } from "@/lib/circle/batch";
import { SimulateProvider } from "@/lib/circle/simulateProvider";
import { readUsycPrice, usycOf } from "@/lib/circle/usyc";
import { quoteEurcInUsdc } from "@/lib/fx/quote";
import { quoteUsdcForEurc } from "@/lib/fx/swap-service";
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
    expect(() => gatewayOf(ARC_MAINNET)).toThrow("Paying through Gateway does not run on Arc mainnet yet");
    expect(() => cctpOf({ ...ARC_MAINNET, cctp: null })).toThrow("Paying through CCTP does not run on Arc mainnet yet");
    await expect(bridgeFee({ ...ARC_MAINNET, cctp: null }, "BASE", 1, { fetch: noRequest })).rejects.toThrow("Paying through CCTP does not run on Arc mainnet yet");
  });

  it("read Arc mainnet's own Iris and TokenMessenger for a payout to Base (mainnet Base payouts B1, B2)", async () => {
    expect(cctpOf(ARC_MAINNET)).toEqual({ domain: 26, iris: "https://iris-api.circle.com", tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" });
    const asked: string[] = [];
    const iris = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify([{ finalityThreshold: 1000, minimumFee: 0, forwardFee: { low: 53826, med: 53857, high: 54130 } }]), { status: 200 });
    }) as unknown as typeof fetch;
    const fee = await bridgeFee(ARC_MAINNET, "BASE", 20, { fetch: iris });
    expect(asked).toEqual(["https://iris-api.circle.com/v2/burn/USDC/fees/26/6?forward=true"]);
    expect(fee).toEqual({ feeUsdc: 0.05413, maxFeeUnits: 54130n, domain: 6 });
    const [approve, burn] = burnCalls({ amount: 20, maxFeeUnits: fee.maxFeeUnits, domain: fee.domain, recipient: PAYEE, usdc: ARC_MAINNET.tokens.USDC, tokenMessenger: cctpOf(ARC_MAINNET).tokenMessenger });
    expect(approve).toMatchObject({ contractAddress: ARC_MAINNET.tokens.USDC, abiParameters: ["0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", "20054130"] });
    expect(burn.contractAddress).toBe("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
    expect(burn.abiParameters.slice(0, 2)).toEqual(["20054130", "6"]);
  });

  it("burn and batch with the USDC they are given", () => {
    const [approve] = burnCalls({ amount: 1, maxFeeUnits: 10n, domain: 6, recipient: PAYEE, usdc: ARC_TESTNET.tokens.USDC, tokenMessenger: cctpOf(ARC_TESTNET).tokenMessenger });
    expect(approve.contractAddress).toBe(ARC_TESTNET.tokens.USDC);
    const calls = batchCalls([{ toAddress: PAYEE, amount: 1 }, { toAddress: PAYEE, amount: 2 }], ARC_MAINNET.tokens.USDC);
    expect(calls.map(([token]) => token)).toEqual([ARC_MAINNET.tokens.USDC, ARC_MAINNET.tokens.USDC]);
  });
});

describe("the USYC reserve reads the profile", () => {
  it("gives Arc testnet's contracts, and refuses on a network without a reserve before any request", async () => {
    expect(usycOf(ARC_TESTNET).teller).toBe("0x9fdF14c5B14173D74C08Af27AebFf39240dC105A");
    await expect(readUsycPrice({ network: ARC_MAINNET, rpcUrl: ARC_MAINNET.rpcUrl, fetch: noRequest })).rejects.toThrow("The USYC reserve does not run on Arc mainnet yet");
  });
});

describe("the EURC swap reads the profile", () => {
  it("refuses by name on a network without the Stablecoin Service, before any request", async () => {
    await expect(quoteUsdcForEurc(1, { network: ARC_MAINNET, apiKey: "k", fromAddress: PAYEE, fetch: noRequest })).rejects.toThrow("The EURC swap does not run on Arc mainnet yet");
    await expect(quoteEurcInUsdc(1, { network: ARC_MAINNET, fromAddress: PAYEE, fetch: noRequest })).rejects.toThrow("The EURC swap does not run on Arc mainnet yet");
  });
});
