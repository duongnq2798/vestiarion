import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { OPEN_PAYABLE_STATUSES, summarizePayableObligations, sumUsdcAmounts } from "@/lib/agent/obligations";

describe("sumUsdcAmounts", () => {
  it("adds the USDC amounts, a row with no currency being USDC, and leaves EURC out", () => {
    expect(sumUsdcAmounts([{ amount: "10" }, { amount: 2.5, currency: "USDC" }, { amount: "100", currency: "EURC" }])).toBe(12.5);
  });
});

describe("the treasury stage's reads (EURC design R3)", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");

  it("reads each open payable's currency for the buffer, and adds up only USDC receivables for the forecast", () => {
    expect(source).toContain('.select("amount, due_date, status, scheduled_for, currency")');
    expect(source).toContain('.select("amount, currency").eq("direction", "receivable")');
    expect(source).toContain("projectedInflow = sumUsdcAmounts(receivables)");
  });
});

describe("payable obligation buffer", () => {
  const now = Date.parse("2026-09-24T00:00:00Z");
  const due = (days: number) => new Date(now + days * 86_400_000).toISOString();

  it("counts USDC payables only: a EURC payable is paid from EURC, not from the USDC the buffer keeps (EURC design R3)", () => {
    const result = summarizePayableObligations([
      { amount: "5", due_date: due(1), status: "pending", currency: "USDC" },
      { amount: "7", due_date: due(2), status: "pending" },
      { amount: "500", due_date: due(1), status: "pending", currency: "EURC" },
    ], now);
    expect(result).toMatchObject({ due7d: 12, due14d: 12, openTotal: 12 });
  });

  it("includes held and awaiting-info payables until they are resolved", () => {
    const result = summarizePayableObligations([
      { amount: "1.000000", due_date: due(1), status: "pending" },
      { amount: "2.000000", due_date: due(2), status: "matched" },
      { amount: "3.000000", due_date: due(3), status: "held" },
      { amount: "4.000000", due_date: due(4), status: "awaiting_info" },
    ], now);
    expect(result.due7d).toBe(10);
    expect(result.openTotal).toBe(10);
    expect(OPEN_PAYABLE_STATUSES).toContain("held");
    expect(OPEN_PAYABLE_STATUSES).toContain("awaiting_info");
  });

  it("excludes paid, rejected, received, and fraud-review rows from committed obligations", () => {
    const result = summarizePayableObligations([
      { amount: "1", due_date: due(1), status: "pending" },
      { amount: "100", due_date: due(1), status: "paid" },
      { amount: "100", due_date: due(1), status: "rejected" },
      { amount: "100", due_date: due(1), status: "received" },
      { amount: "100", due_date: due(1), status: "flagged" },
    ], now);
    expect(result.due7d).toBe(1);
    expect(result.openTotal).toBe(1);
  });

  it("keeps later obligations open but outside the shorter window", () => {
    const result = summarizePayableObligations([
      { amount: "5", due_date: due(10), status: "held" },
    ], now);
    expect(result.due7d).toBe(0);
    expect(result.due14d).toBe(5);
    expect(result.openTotal).toBe(5);
    expect(result.daysUntilNext).toBe(10);
  });

  it("counts a scheduled payable as open, alongside pending/matched/held/awaiting_info", () => {
    expect(OPEN_PAYABLE_STATUSES).toContain("scheduled");
    const result = summarizePayableObligations([
      { amount: "6", due_date: due(20), status: "scheduled", scheduled_for: due(3) },
    ], now);
    expect(result.due7d).toBe(6);
    expect(result.openTotal).toBe(6);
  });

  it("dates a scheduled row by scheduled_for, not by the (later) due date", () => {
    const result = summarizePayableObligations([
      // Due in 20 days, but scheduled to leave in 3 — the buffer must see it at 3.
      { amount: "6", due_date: due(20), status: "scheduled", scheduled_for: due(3) },
    ], now);
    expect(result.due7d).toBe(6);
    expect(result.due14d).toBe(6);
    expect(result.daysUntilNext).toBe(3);
  });

  it("falls back to due_date when a scheduled row has no scheduled_for", () => {
    const result = summarizePayableObligations([
      { amount: "6", due_date: due(3), status: "scheduled" },
    ], now);
    expect(result.due7d).toBe(6);
    expect(result.daysUntilNext).toBe(3);
  });
});
