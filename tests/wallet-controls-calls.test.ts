import { decodeFunctionData, erc20Abi, getAddress, maxUint256 } from "viem";
import { describe, expect, it } from "vitest";
import { setLimitsData } from "@/lib/spending-limit/deployment";
import { FIGURES_REFUSED, figuresCall, resumeCall, stopCall } from "@/lib/treasury/wallet-controls";

/**
 * The calls a treasury's own wallet signs to change its contract's figures, or to stop and resume the agent's payments
 * (docs/superpowers/specs/2026-10-07-treasury-wallet-controls-design.md C2): built in the browser from what the panel
 * shows, and refused there where the contract would refuse them, before anything is signed.
 */

const CONTRACT = getAddress("0xd90cA89Fc318d0330Bb14eaeF78B72C3CA7E7fB6");
const USDC = getAddress("0x3600000000000000000000000000000000000000");
const BOTH = { dailyUsdc: 50, weeklyUsdc: 150 };
const WEEKLY_ONLY = { dailyUsdc: null, weeklyUsdc: 150 };

describe("figuresCall", () => {
  it("calls setLimits on the contract with the figures in units", () => {
    expect(figuresCall({ contract: CONTRACT, daily: "50", weekly: "150", holds: BOTH })).toEqual({
      to: CONTRACT,
      data: setLimitsData(50_000_000n, 150_000_000n),
      value: 0n,
      dailyUnits: 50_000_000n,
      weeklyUnits: 150_000_000n,
    });
  });

  it("reads a figure exactly as typed, to the 6 decimals USDC carries", () => {
    expect(figuresCall({ contract: CONTRACT, daily: "0.000001", weekly: "1,000.5", holds: BOTH })).toMatchObject({ dailyUnits: 1n, weeklyUnits: 1_000_500_000n });
    expect(figuresCall({ contract: CONTRACT, daily: "0.1", weekly: "0.3", holds: BOTH })).toMatchObject({ dailyUnits: 100_000n, weeklyUnits: 300_000n });
  });

  it("keeps empty a figure the contract does not hold", () => {
    expect(figuresCall({ contract: CONTRACT, daily: " ", weekly: "12.5", holds: WEEKLY_ONLY })).toMatchObject({ dailyUnits: 0n, weeklyUnits: 12_500_000n });
  });

  it("never removes a figure the contract holds: an emptied field is refused, not sent as no figure", () => {
    expect(() => figuresCall({ contract: CONTRACT, daily: "", weekly: "150", holds: BOTH })).toThrow(
      "Enter a daily figure above 0 USDC. The contract holds one now, and this page does not remove it."
    );
    expect(() => figuresCall({ contract: CONTRACT, daily: "50", weekly: " ", holds: BOTH })).toThrow(
      "Enter a 7-day figure above 0 USDC. The contract holds one now, and this page does not remove it."
    );
  });

  it.each([
    ["0", "200", "The daily figure must be more than 0 USDC."],
    ["-5", "10", "The daily figure must be more than 0 USDC."],
    ["0.0000004", "200", "The daily figure can have at most 6 decimal places."],
    ["0x10", "200", "The daily figure must be a number of USDC."],
    ["50", "fifty", "The 7-day figure must be a number of USDC."],
    ["50", "0", "The 7-day figure must be more than 0 USDC."],
    ["50", "20", FIGURES_REFUSED],
  ])("refuses %s a day and %s in 7 days before anything is signed", (daily, weekly, message) => {
    expect(() => figuresCall({ contract: CONTRACT, daily, weekly, holds: BOTH })).toThrow(message);
  });

  it("refuses no figure at all, as the contract would", () => {
    expect(() => figuresCall({ contract: CONTRACT, daily: "", weekly: "", holds: { dailyUsdc: null, weeklyUsdc: null } })).toThrow(FIGURES_REFUSED);
  });
});

describe("stopCall and resumeCall", () => {
  it("stops the agent by approving nothing on USDC", () => {
    const call = stopCall({ usdc: USDC, contract: CONTRACT });
    expect(call.to).toBe(USDC);
    expect(call.value).toBe(0n);
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data }).args).toEqual([CONTRACT, 0n]);
  });

  it("resumes without a cap, or up to one, exactly as typed", () => {
    expect(decodeFunctionData({ abi: erc20Abi, data: resumeCall({ usdc: USDC, contract: CONTRACT, cap: "" }).data }).args).toEqual([CONTRACT, maxUint256]);
    expect(decodeFunctionData({ abi: erc20Abi, data: resumeCall({ usdc: USDC, contract: CONTRACT, cap: "250" }).data }).args).toEqual([CONTRACT, 250_000_000n]);
    expect(decodeFunctionData({ abi: erc20Abi, data: resumeCall({ usdc: USDC, contract: CONTRACT, cap: "0.1" }).data }).args).toEqual([CONTRACT, 100_000n]);
  });

  it.each(["0", "lots", "0x10", "0.0000004", "-3"])("refuses the cap %s, which is not a figure above 0 USDC", (cap) => {
    expect(() => resumeCall({ usdc: USDC, contract: CONTRACT, cap })).toThrow("Give the cap in USDC, above 0, or leave it empty.");
  });
});
