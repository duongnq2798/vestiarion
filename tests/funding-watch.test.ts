import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FUNDING_WATCH_INTERVAL_MS, FUNDING_WATCH_LIMIT_MS, shouldReadBalanceAgain } from "@/lib/funding-watch";

/**
 * While the operating wallet is unfunded, the Go live panel reads its balance
 * again on its own: when the person comes back from the faucet, and every 30 s
 * while the tab is visible, for 15 minutes (first-payment design R1).
 */

const OPENED = Date.parse("2026-10-01T09:00:00Z");
const waiting = { balance: 0, openedAt: OPENED, now: OPENED + 60_000, visible: true, pending: false, sample: false };

describe("shouldReadBalanceAgain", () => {
  it("reads again while the wallet is unfunded or unread, the tab is visible, and nothing is being read", () => {
    expect(shouldReadBalanceAgain(waiting)).toBe(true);
    expect(shouldReadBalanceAgain({ ...waiting, balance: null })).toBe(true);
  });

  it("stops once the wallet holds USDC", () => {
    expect(shouldReadBalanceAgain({ ...waiting, balance: 20 })).toBe(false);
  });

  it("waits while the tab is hidden, or a read is already running", () => {
    expect(shouldReadBalanceAgain({ ...waiting, visible: false })).toBe(false);
    expect(shouldReadBalanceAgain({ ...waiting, pending: true })).toBe(false);
  });

  it("never reads for a sample balance", () => {
    expect(shouldReadBalanceAgain({ ...waiting, sample: true })).toBe(false);
  });

  it("gives up 15 minutes after the panel opened", () => {
    expect(shouldReadBalanceAgain({ ...waiting, now: OPENED + FUNDING_WATCH_LIMIT_MS - 1 })).toBe(true);
    expect(shouldReadBalanceAgain({ ...waiting, now: OPENED + FUNDING_WATCH_LIMIT_MS })).toBe(false);
  });

  it("reads every 30 seconds for up to 15 minutes", () => {
    expect(FUNDING_WATCH_INTERVAL_MS).toBe(30_000);
    expect(FUNDING_WATCH_LIMIT_MS).toBe(15 * 60_000);
  });
});

describe("the Go live panel's balance line", () => {
  const panel = readFileSync(path.join(process.cwd(), "src", "components", "GoLivePanel.tsx"), "utf8");

  it("reads again on an interval and when the tab becomes visible, and cleans both up", () => {
    expect(panel).toContain("setInterval(readAgain, FUNDING_WATCH_INTERVAL_MS)");
    expect(panel).toContain('document.addEventListener("visibilitychange", readAgain)');
    expect(panel).toContain("clearInterval(timer)");
    expect(panel).toContain('document.removeEventListener("visibilitychange", readAgain)');
    expect(panel).toContain("shouldReadBalanceAgain(");
  });
});
