import { describe, expect, it } from "vitest";
import { factsFromEntry, type ReplayEntry } from "@/lib/research/replay";

/**
 * Rebuilding the facts of a recorded payable decision, to ask the model
 * again with today's prompt (research note "When the model and the policy
 * disagree", follow-up). The facts come from the decision's own ledger entry,
 * the invoice and counterparty rows when they still exist, and the other
 * invoices its duplicate check named.
 */

const ENTRY: ReplayEntry = {
  seq: 426,
  ts: "2026-09-30T16:03:36.992Z",
  summary: "FLAG_FRAUD invoice from Centronex for 2 USDC",
  detail: {
    observed: {
      amount: 2,
      riskLevel: "clear",
      poReference: "PO-100",
      paymentLimit: 2,
      goodsReceived: true,
      operatingBalance: 22.5,
      performanceHistory: { score: 0.6, status: "measured_from_ledger" },
      duplicateCheck: {
        matchesTotal: 2,
        matches: [
          { finding: "Resembles invoice due 2026-09-30 (already paid): same_amount, close_due_dates. Confidence 0.60.", signals: ["same_amount", "close_due_dates"], confidence: 0.6, otherInvoiceId: "a1", otherInvoiceStatus: "paid" },
          { finding: "Resembles invoice due 2026-10-02 (status pending): same_amount, close_due_dates. Confidence 0.60.", signals: ["same_amount", "close_due_dates"], confidence: 0.6, otherInvoiceId: "gone", otherInvoiceStatus: "pending" },
        ],
      },
    },
  },
};

describe("rebuilding a recorded payable decision's facts", () => {
  const facts = factsFromEntry(ENTRY, {
    invoice: { memo: "Monitoring", due_date: "2026-09-30T12:00:00.000Z" },
    counterparty: { name: "Centronex" },
    others: new Map([["a1", { amount: 2, due_date: "2026-09-30T12:00:00.000Z" }]]),
  });

  it("takes the invoice and counterparty facts the entry recorded", () => {
    expect(facts.invoice).toEqual({ amount: 2, currency: "USDC", usdcValue: 2, memo: "Monitoring", poReference: "PO-100", goodsReceived: true, dueDate: "2026-09-30T12:00:00.000Z" });
    expect(facts.counterparty).toEqual({ name: "Centronex", riskLevel: "clear", paymentLimit: 2, performanceHistory: { score: 0.6, status: "measured_from_ledger" } });
    expect(facts.treasury).toEqual({ operatingBalance: 22.5, reserveBalance: 0 });
  });

  it("names the other invoices of the duplicate check, from their rows or else from the finding", () => {
    expect(facts.duplicateMatchesTotal).toBe(2);
    expect(facts.duplicateMatches.map(({ otherInvoiceStatus, otherInvoiceDueDate, otherInvoiceAmount }) => [otherInvoiceStatus, otherInvoiceDueDate, otherInvoiceAmount])).toEqual([
      ["paid", "2026-09-30T12:00:00.000Z", 2],
      ["pending", "2026-10-02", 2],
    ]);
  });

  it("rebuilds the timing an entry made before timing was recorded: due that day, nothing else falling due", () => {
    expect(facts.timing).toEqual({
      today: "2026-09-30",
      dueOn: "2026-09-30",
      discountValue: 0,
      discountAvailableUntil: null,
      floatValueToDue: 0,
      targetOn: "2026-09-30",
      amountDueAtTarget: 2,
      earlierObligations: { total: 0, count: 0 },
      shortfall: false,
    });
  });

  it("takes the counterparty's name from the summary when its row is gone", () => {
    const gone = factsFromEntry(ENTRY, { invoice: null, counterparty: null, others: new Map() });
    expect(gone.counterparty.name).toBe("Centronex");
    expect(gone.invoice.memo).toBeNull();
    expect(gone.invoice.dueDate).toBe("2026-09-30");
  });

  it("uses the timing an entry recorded, as the model was shown it", () => {
    const recorded = factsFromEntry(
      { ...ENTRY, detail: { ...ENTRY.detail, timing: { today: "2026-10-01", dueOn: "2026-10-31", discountValue: 4, discountAvailableUntil: "2026-10-11", floatValueToDue: 0.1, targetOn: "2026-10-11", amountDueAtTarget: 392, earlierObligations: { total: 0, count: 0 }, shortfall: false, recommendation: "schedule", reason: "withheld" } } },
      { invoice: null, counterparty: null, others: new Map() }
    );
    expect(recorded.timing).not.toHaveProperty("recommendation");
    expect(recorded.timing).toMatchObject({ targetOn: "2026-10-11", amountDueAtTarget: 392 });
  });
});
