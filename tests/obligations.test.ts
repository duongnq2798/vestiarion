import { describe, expect, it } from "vitest";
import { OPEN_PAYABLE_STATUSES, summarizePayableObligations } from "@/lib/agent/obligations";

describe("payable obligation buffer", () => {
  const now = Date.parse("2026-09-24T00:00:00Z");
  const due = (days: number) => new Date(now + days * 86_400_000).toISOString();

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
});
