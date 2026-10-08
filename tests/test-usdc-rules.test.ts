import { describe, expect, it } from "vitest";
import { walletIdempotencyKey } from "@/lib/circle/provision";
import { ceilCents, takenInWindow, testUsdcAmount, testUsdcKey, testUsdcView, WEEK_MS } from "@/lib/test-usdc-rules";

/** Test USDC for shadow mode (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T3, T4, T8): the pure rules. */

describe("ceilCents", () => {
  it("rounds up to the cent, and leaves a whole cent alone", () => {
    expect(ceilCents(480.001)).toBe(480.01);
    expect(ceilCents(480.1)).toBe(480.1);
    expect(ceilCents(0.3)).toBe(0.3);
  });
});

describe("testUsdcAmount", () => {
  const base = { takenThisWeek: 0, weeklyLimit: 5000, floatBalance: 10_000 };
  it("adds what the open bills need: minus safe to spend, rounded up to the cent", () => {
    expect(testUsdcAmount({ ...base, safeToSpend: -480.004 })).toEqual({ amount: 480.01, shortfall: 480.01 });
  });
  it("adds at least 1 USDC", () => {
    expect(testUsdcAmount({ ...base, safeToSpend: -0.25 })).toEqual({ amount: 1, shortfall: 0.25 });
  });
  it("adds nothing when the wallet covers the bills", () => {
    expect(testUsdcAmount({ ...base, safeToSpend: 0 })).toEqual({ refused: "nothing_needed", shortfall: 0 });
    expect(testUsdcAmount({ ...base, safeToSpend: 12 })).toEqual({ refused: "nothing_needed", shortfall: 0 });
  });
  it("stops at what the workspace may still take this week", () => {
    expect(testUsdcAmount({ ...base, safeToSpend: -3000, takenThisWeek: 4000 })).toEqual({ amount: 1000, shortfall: 3000 });
    expect(testUsdcAmount({ ...base, safeToSpend: -3000, takenThisWeek: 4999.5 })).toEqual({ refused: "limit_reached", shortfall: 3000 });
  });
  it("stops at what the float holds, and adds nothing from a float under 1 USDC", () => {
    expect(testUsdcAmount({ ...base, safeToSpend: -3000, floatBalance: 1200.5 })).toEqual({ amount: 1200.5, shortfall: 3000 });
    expect(testUsdcAmount({ ...base, safeToSpend: -3000, floatBalance: 0.9 })).toEqual({ refused: "float_empty", shortfall: 3000 });
  });
});

describe("takenInWindow", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  it("adds the amounts of the last 7 days' entries and ignores older ones and nonsense", () => {
    const entries = [
      { ts: "2026-10-08T11:00:00Z", detail: { amount: 480.01 } },
      { ts: new Date(now - WEEK_MS + 60_000).toISOString(), detail: { amount: "20" } },
      { ts: new Date(now - WEEK_MS - 60_000).toISOString(), detail: { amount: 1000 } },
      { ts: "2026-10-08T10:00:00Z", detail: { amount: "abc" } },
      { ts: "2026-10-08T10:00:00Z", detail: {} },
    ];
    expect(takenInWindow(entries, now)).toBeCloseTo(500.01, 6);
  });
});

describe("testUsdcKey", () => {
  it("is a Circle idempotency key derived from the workspace and the grant's ordinal", () => {
    const org = "0b6c1c9e-4a4f-4a7e-9b1e-000000002a2a";
    expect(testUsdcKey(org, 3)).toBe(walletIdempotencyKey(org, "test-usdc:3"));
    expect(testUsdcKey(org, 3)).not.toBe(testUsdcKey(org, 4));
  });
});

describe("testUsdcView", () => {
  const base = { takenThisWeek: 0, weeklyLimit: 5000, available: true, canAdd: true };
  it("shows nothing when safe to spend is not below zero", () => {
    expect(testUsdcView({ ...base, safeToSpend: 0 })).toBeNull();
  });
  it("offers the shortfall to someone who may add it", () => {
    expect(testUsdcView({ ...base, safeToSpend: -480.004 })).toEqual({ need: 480.01, action: "add", amount: 480.01 });
  });
  it("offers what is left of the week when the shortfall is larger", () => {
    expect(testUsdcView({ ...base, safeToSpend: -3000, takenThisWeek: 4500 })).toEqual({ need: 3000, action: "add", amount: 500 });
  });
  it("says the week's limit is used", () => {
    expect(testUsdcView({ ...base, safeToSpend: -3000, takenThisWeek: 5000 })).toEqual({ need: 3000, action: "limit", weeklyLimit: 5000 });
  });
  it("shows the need alone without the float, or to someone who may not add it", () => {
    expect(testUsdcView({ ...base, safeToSpend: -10, available: false })).toEqual({ need: 10, action: null });
    expect(testUsdcView({ ...base, safeToSpend: -10, canAdd: false })).toEqual({ need: 10, action: null });
  });
});
