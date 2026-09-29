import { describe, expect, it } from "vitest";
import { balanceTileCopy, balanceTileMode } from "@/components/vx/Treasury";

/**
 * The balance tile's label and sub-line, pinned as a pure function so the
 * sandbox-vs-live wording is testable without rendering the component. A
 * workspace whose funds are not on-chain (no live payments, or no real wallet
 * yet) gets the simulated wording, never "on-chain" — the
 * label must say so regardless of the simulated reserve amount, which is
 * what previously read "Balance on-chain" even in a sandbox.
 */
describe("balanceTileMode", () => {
  const wallet = { kind: "operating", circle_wallet_id: "w-1" };
  const noWallet = { kind: "operating", circle_wallet_id: null };

  it("calls the funds on-chain only when payments are live and the operating account has a real wallet", () => {
    expect(balanceTileMode("live", [wallet])).toBe("live");
    // A sandbox that connected Circle or took a hosted wallet pays for real on a hand-run cycle.
    expect(balanceTileMode("live", [wallet, { kind: "reserve", circle_wallet_id: null }])).toBe("live");
  });

  it("keeps the simulated wording before any real wallet exists, or while payments are simulated", () => {
    expect(balanceTileMode("live", [noWallet])).toBe("sandbox");
    expect(balanceTileMode("live", [])).toBe("sandbox");
    expect(balanceTileMode("simulate", [wallet])).toBe("sandbox");
  });
});

describe("balanceTileCopy", () => {
  it("labels a sandbox balance as simulated regardless of the simulated reserve", () => {
    expect(balanceTileCopy("sandbox", 0)).toEqual({
      label: "Balance (simulated)",
      sub: "Sandbox workspace: these funds are simulated, nothing is on-chain",
    });
    expect(balanceTileCopy("sandbox", 500)).toEqual({
      label: "Balance (simulated)",
      sub: "Sandbox workspace: these funds are simulated, nothing is on-chain",
    });
  });

  it("keeps the live on-chain label, with a fixed sub-line when nothing is simulated", () => {
    expect(balanceTileCopy("live", 0)).toEqual({
      label: "Balance on-chain",
      sub: "All funds shown are on-chain",
    });
  });

  it("keeps the live on-chain label, deferring to the caller's own sub-line when a reserve is simulated", () => {
    expect(balanceTileCopy("live", 500)).toEqual({
      label: "Balance on-chain",
      sub: null,
    });
  });
});
