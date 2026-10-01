import { describe, expect, it } from "vitest";
import { duplicateNote } from "@/lib/agent/orchestrator";

/**
 * What the model is told about payables that resemble this one. The written
 * policy stops a payment as a duplicate only when it bills the same purchase
 * order for the same amount as one already paid or committed; a match on
 * amount and dates alone is weighed. The model was told every match of a paid
 * invoice is duplicate billing, and flagged invoices the policy would pay
 * (research note "When the model and the policy disagree").
 */
describe("the duplicate note", () => {
  it("says so when nothing resembles the invoice", () => {
    expect(duplicateNote(0, 0)).toBe("No earlier payable from this counterparty resembles this invoice.");
  });

  it("calls a repeat of the same purchase order and amount duplicate billing, which code stops either way", () => {
    expect(duplicateNote(2, 2)).toContain(
      "A match that bills the same purchase order for the same amount as an invoice already paid, being paid, scheduled or being decided by a person is duplicate billing: flag it. Code stops it either way."
    );
  });

  it("calls a match on amount and dates alone a signal to weigh, not proof", () => {
    expect(duplicateNote(2, 2)).toContain(
      "A match on amount and due dates alone, under a different purchase order or none, is a signal to weigh, not proof: vendors often bill the same amount on the same cycle. Do not flag on it alone; flag it when other facts point the same way, and say in your reasoning how you weighed it."
    );
  });
});
