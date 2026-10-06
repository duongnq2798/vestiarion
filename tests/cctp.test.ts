import { describe, expect, it, vi } from "vitest";
import { ARC_TESTNET } from "@/lib/network";
import { BridgeFeeError, bridgeFee, burnCalls, CCTP_FORWARD_HOOK, forwardedMint, toBytes32 } from "@/lib/circle/cctp";

/**
 * CCTP V2 from Arc testnet with the Forwarding Service (docs/superpowers/specs/2026-10-01-cctp-payouts-design.md
 * X2, X3, X8): the fee from Iris, the two calls the operating wallet makes, and the mint Circle forwards.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Iris's answer for Arc → Base Sepolia on 2026-10-01. */
const FEES = [
  { finalityThreshold: 1000, minimumFee: 0, forwardFee: { low: 54277, med: 54277, high: 54613 } },
  { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 54277, med: 54277, high: 54613 } },
];

describe("bridgeFee", () => {
  it("asks Iris for a fast forwarded transfer from Arc's domain and takes the high forwarding fee (R3)", async () => {
    const fetch = vi.fn(async () => json(FEES));
    const fee = await bridgeFee(ARC_TESTNET, "BASE-SEPOLIA", 1.5, { fetch });
    expect(fetch).toHaveBeenCalledWith("https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/26/6?forward=true", expect.anything());
    expect(fee).toEqual({ feeUsdc: 0.054613, maxFeeUnits: BigInt(54613), domain: 6 });
  });

  it("adds the protocol's minimum fee, in basis points of the amount", async () => {
    const fetch = vi.fn(async () => json([{ finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 100, med: 100, high: 100 } }]));
    // 1 bp of 100 USDC is 0.01 USDC.
    expect(await bridgeFee(ARC_TESTNET, "ARB-SEPOLIA", 100, { fetch })).toEqual({ feeUsdc: 0.0101, maxFeeUnits: BigInt(10100), domain: 3 });
  });

  it("fails as BridgeFeeError when Iris does not answer, answers an error, or has no fast route", async () => {
    await expect(bridgeFee(ARC_TESTNET, "BASE-SEPOLIA", 1, { fetch: vi.fn().mockRejectedValue(new TypeError("fetch failed")) })).rejects.toBeInstanceOf(BridgeFeeError);
    await expect(bridgeFee(ARC_TESTNET, "BASE-SEPOLIA", 1, { fetch: vi.fn(async () => json({ message: "down" }, 503)) })).rejects.toBeInstanceOf(BridgeFeeError);
    await expect(bridgeFee(ARC_TESTNET, "BASE-SEPOLIA", 1, { fetch: vi.fn(async () => json([{ finalityThreshold: 2000, minimumFee: 0, forwardFee: { high: 1 } }])) })).rejects.toBeInstanceOf(BridgeFeeError);
  });

  it("has no fee for Arc itself, which is paid directly", async () => {
    await expect(bridgeFee(ARC_TESTNET, "ARC-TESTNET", 1, { fetch: vi.fn() })).rejects.toThrow(/not paid across chains/);
  });
});

describe("burnCalls", () => {
  it("approves TokenMessengerV2 for the amount and the fee, then burns both with the forwarding hook", () => {
    const [approve, burn] = burnCalls({ amount: 1.5, maxFeeUnits: BigInt(54613), domain: 6, recipient: "0xAbC0000000000000000000000000000000000dEf", usdc: ARC_TESTNET.tokens.USDC, tokenMessenger: ARC_TESTNET.cctp.tokenMessenger });
    expect(approve).toEqual({
      contractAddress: ARC_TESTNET.tokens.USDC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [ARC_TESTNET.cctp.tokenMessenger, "1554613"],
    });
    expect(burn).toEqual({
      contractAddress: ARC_TESTNET.cctp.tokenMessenger,
      abiFunctionSignature: "depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)",
      abiParameters: [
        "1554613",
        "6",
        "0x000000000000000000000000abc0000000000000000000000000000000000def",
        ARC_TESTNET.tokens.USDC,
        `0x${"0".repeat(64)}`,
        "54613",
        "1000",
        CCTP_FORWARD_HOOK,
      ],
    });
  });

  it("writes an address as the 32 bytes CCTP takes, and refuses one that is not an address", () => {
    expect(toBytes32("0x19801dAA2F1E5E5e707b7E57Ff664f3d27fFdd12")).toBe("0x00000000000000000000000019801daa2f1e5e5e707b7e57ff664f3d27ffdd12");
    expect(() => toBytes32("0x1234")).toThrow(/not an address/);
  });
});

describe("forwardedMint", () => {
  const BURN = "0x2e66257f2cf478ecd2d0f7e263e1ad78bf9877b0afb93f3679c0601ef7328f58";

  it("finds the mint Circle forwarded, by the burn's transaction on Arc", async () => {
    const fetch = vi.fn(async () => json({ messages: [{ status: "complete", forwardTxHash: "0xmint" }] }));
    expect(await forwardedMint(ARC_TESTNET, BURN, { fetch })).toEqual({ mintTxHash: "0xmint" });
    expect(fetch).toHaveBeenCalledWith(`https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash=${BURN}`, expect.anything());
  });

  it("has nothing yet while the message is pending, not found, or Iris does not answer", async () => {
    expect(await forwardedMint(ARC_TESTNET, BURN, { fetch: vi.fn(async () => json({ messages: [{ status: "pending_confirmations" }] })) })).toBeNull();
    expect(await forwardedMint(ARC_TESTNET, BURN, { fetch: vi.fn(async () => json({ error: "Message hash not found" }, 404)) })).toBeNull();
    expect(await forwardedMint(ARC_TESTNET, BURN, { fetch: vi.fn().mockRejectedValue(new TypeError("fetch failed")) })).toBeNull();
  });
});
