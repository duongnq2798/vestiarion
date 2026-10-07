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

describe("figuresCall", () => {
  it("calls setLimits on the contract with the figures in units", () => {
    expect(figuresCall({ contract: CONTRACT, daily: "50", weekly: "150" })).toEqual({
      to: CONTRACT,
      data: setLimitsData(50_000_000n, 150_000_000n),
      value: 0n,
      dailyUnits: 50_000_000n,
      weeklyUnits: 150_000_000n,
    });
  });

  it("reads an empty figure as none, and rounds a figure to the cent's fraction USDC carries", () => {
    expect(figuresCall({ contract: CONTRACT, daily: " ", weekly: "12.5" })).toMatchObject({ dailyUnits: 0n, weeklyUnits: 12_500_000n });
    expect(figuresCall({ contract: CONTRACT, daily: "0.1234567", weekly: "" })).toMatchObject({ dailyUnits: 123_457n, weeklyUnits: 0n });
  });

  it.each([
    ["", ""],
    ["0", "0"],
    ["50", "20"],
    ["-5", "10"],
    ["fifty", "100"],
  ])("refuses %s a day and %s in 7 days before anything is signed, as the contract would", (daily, weekly) => {
    expect(() => figuresCall({ contract: CONTRACT, daily, weekly })).toThrow(FIGURES_REFUSED);
  });
});

describe("stopCall and resumeCall", () => {
  it("stops the agent by approving nothing on USDC", () => {
    const call = stopCall({ usdc: USDC, contract: CONTRACT });
    expect(call.to).toBe(USDC);
    expect(call.value).toBe(0n);
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data }).args).toEqual([CONTRACT, 0n]);
  });

  it("resumes without a cap, or up to one", () => {
    expect(decodeFunctionData({ abi: erc20Abi, data: resumeCall({ usdc: USDC, contract: CONTRACT, cap: "" }).data }).args).toEqual([CONTRACT, maxUint256]);
    expect(decodeFunctionData({ abi: erc20Abi, data: resumeCall({ usdc: USDC, contract: CONTRACT, cap: "250" }).data }).args).toEqual([CONTRACT, 250_000_000n]);
  });

  it("refuses a cap that is not a figure above 0 USDC", () => {
    expect(() => resumeCall({ usdc: USDC, contract: CONTRACT, cap: "0" })).toThrow("Give the cap in USDC, above 0, or leave it empty.");
    expect(() => resumeCall({ usdc: USDC, contract: CONTRACT, cap: "lots" })).toThrow("Give the cap in USDC, above 0, or leave it empty.");
  });
});
