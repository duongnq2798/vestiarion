import { describe, expect, it } from "vitest";
import {
  ARC_TESTNET_CHAIN_ID,
  feeUsdFromReceipt,
  receiptReverted,
  type ArcReceipt,
} from "@/lib/circle/arcFees";
import { ARC_FEE_USD, ARC_SETTLEMENT_MS_MAX, ARC_SETTLEMENT_MS_MIN } from "@/lib/circle/types";

/**
 * Receipts as Arc testnet actually returned them for the first four transfers
 * the agent executed. Keeping the real values here means a change to the
 * arithmetic has to disagree with observed reality to pass unnoticed.
 */
const OBSERVED: Array<{ hash: string; receipt: ArcReceipt; feeUsd: number }> = [
  {
    hash: "0x36ea71ac97cad3743f227860785207e6f25148251735569be0f6b16c73130343",
    receipt: { gasUsed: "0x1f1de", effectiveGasPrice: "0x5f05b0a00", status: "0x1" },
    feeUsd: 0.003248,
  },
  {
    hash: "0xabd0a84dc528c6cd1f0b9995ca798f5717fd0719f3c9b36000978efda78e8ec6",
    receipt: { gasUsed: "0x1f202", effectiveGasPrice: "0x5d21dba00", status: "0x1" },
    feeUsd: 0.003185,
  },
];

describe("feeUsdFromReceipt", () => {
  it("converts gas x price to dollars, because Arc's gas token is USDC", () => {
    // 127390 gas x 25.5 gwei = 3.248445e15 wei; at 18 decimals that is $0.003248.
    expect(feeUsdFromReceipt({ gasUsed: "127390", effectiveGasPrice: "25500000000", status: "0x1" }))
      .toBeCloseTo(0.003248, 6);
  });

  it("accepts hex quantities, which is what JSON-RPC returns", () => {
    for (const { receipt, feeUsd } of OBSERVED) {
      expect(feeUsdFromReceipt(receipt)).toBeCloseTo(feeUsd, 5);
    }
  });

  it("agrees with the fallback constant to within the spread it was drawn from", () => {
    // The constant exists to stand in for the chain when the chain is
    // unreachable. If measurement drifts far from it, the fallback is lying.
    for (const { receipt } of OBSERVED) {
      const fee = feeUsdFromReceipt(receipt)!;
      expect(Math.abs(fee - ARC_FEE_USD) / ARC_FEE_USD).toBeLessThan(0.05);
    }
  });

  it("does not lose precision going through 18 decimals", () => {
    // 1 wei must not round up to a visible fee, and must not become NaN.
    expect(feeUsdFromReceipt({ gasUsed: "1", effectiveGasPrice: "1", status: "0x1" })).toBe(0);
  });

  it("converts exactly at the 18-decimal boundary", () => {
    // 1e6 gas x 1e12 wei/gas = 1e18 wei, which is exactly one USDC.
    expect(feeUsdFromReceipt({ gasUsed: "1000000", effectiveGasPrice: "1000000000000", status: "0x1" }))
      .toBe(1);
  });

  it("handles a product far beyond Number.MAX_SAFE_INTEGER", () => {
    // 1e6 gas x 1e18 wei/gas = 1e24 wei. Multiplying these as numbers first
    // would have lost precision long before the division.
    expect(feeUsdFromReceipt({ gasUsed: "1000000", effectiveGasPrice: "1000000000000000000", status: "0x1" }))
      .toBe(1_000_000);
  });

  it("returns null rather than zero when the receipt is unusable", () => {
    // Zero is a claim about what a transfer cost. Null is the absence of one,
    // and the caller must be able to tell them apart.
    expect(feeUsdFromReceipt(null)).toBeNull();
    expect(feeUsdFromReceipt(undefined)).toBeNull();
    expect(feeUsdFromReceipt({ gasUsed: "", effectiveGasPrice: "1", status: "0x1" })).toBeNull();
    expect(feeUsdFromReceipt({ gasUsed: "1", effectiveGasPrice: "", status: "0x1" })).toBeNull();
    expect(feeUsdFromReceipt({ gasUsed: "nonsense", effectiveGasPrice: "1", status: "0x1" })).toBeNull();
  });
});

describe("receiptReverted", () => {
  it("recognises a reverted transaction", () => {
    expect(receiptReverted({ gasUsed: "1", effectiveGasPrice: "1", status: "0x0" })).toBe(true);
  });

  it("does not treat a successful or missing receipt as reverted", () => {
    expect(receiptReverted(OBSERVED[0].receipt)).toBe(false);
    expect(receiptReverted(null)).toBe(false);
  });
});

describe("measured Arc constants", () => {
  it("pins the chain the fees were read from", () => {
    expect(ARC_TESTNET_CHAIN_ID).toBe(5042002);
  });

  it("keeps the fallback fee at the measured order of magnitude", () => {
    // Guards against a future edit quietly restoring the old round $0.01,
    // which was 3x the real cost and made the treasury policy that much more
    // reluctant to sweep.
    expect(ARC_FEE_USD).toBeGreaterThan(0.002);
    expect(ARC_FEE_USD).toBeLessThan(0.005);
  });

  it("keeps the simulated latency range at the measured order of magnitude", () => {
    // The old range was 320-470ms and claimed to be Arc's real profile.
    expect(ARC_SETTLEMENT_MS_MIN).toBeGreaterThanOrEqual(1_000);
    expect(ARC_SETTLEMENT_MS_MAX).toBeGreaterThan(ARC_SETTLEMENT_MS_MIN);
    expect(ARC_SETTLEMENT_MS_MAX).toBeLessThanOrEqual(10_000);
  });
});
