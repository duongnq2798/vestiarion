import { describe, expect, it } from "vitest";
import {
  blockingDuplicate,
  DUPLICATE_BLOCK_CONFIDENCE,
  findDuplicates,
  scoreDuplicate,
  type InvoiceLike,
} from "@/lib/agent/duplicates";

function inv(over: Partial<InvoiceLike> = {}): InvoiceLike {
  return {
    id: "inv-new",
    counterpartyId: "cp-vercel",
    amount: 240,
    memo: "Hosting — September",
    poReference: "PO-1042",
    dueDate: "2026-09-27T00:00:00.000Z",
    status: "pending",
    ...over,
  };
}

const paid = (over: Partial<InvoiceLike> = {}) =>
  inv({ id: "inv-old", status: "paid", ...over });

describe("scoreDuplicate — the case that costs money", () => {
  it("catches a re-send of an invoice already paid", () => {
    const match = scoreDuplicate(inv(), paid());
    expect(match).not.toBeNull();
    expect(match!.confidence).toBeGreaterThanOrEqual(DUPLICATE_BLOCK_CONFIDENCE);
    expect(match!.againstSettled).toBe(true);
    expect(match!.signals).toContain("same_purchase_order");
  });

  it("explains the match in terms a reviewer can check", () => {
    const match = scoreDuplicate(inv(), paid())!;
    expect(match.explanation).toContain("same purchase order");
    expect(match.explanation).toContain("240");
    expect(match.explanation).toContain("already paid");
  });

  it("normalises purchase orders written inconsistently", () => {
    for (const po of ["po 1042", "PO_1042", "1042", "po-1042"]) {
      const match = scoreDuplicate(inv(), paid({ poReference: po }));
      expect(match, `PO "${po}" should still match`).not.toBeNull();
      expect(match!.signals).toContain("same_purchase_order");
    }
  });

  it("caps confidence when the twin is itself still unpaid", () => {
    // Worth raising — nothing has left the account yet, so it is not a loss
    // and code should not refuse on its own authority.
    const match = scoreDuplicate(inv(), inv({ id: "inv-old", status: "pending" }))!;
    expect(match.againstSettled).toBe(false);
    expect(match.confidence).toBeLessThan(DUPLICATE_BLOCK_CONFIDENCE);
  });

  it("flags one purchase order billed twice at different amounts", () => {
    const match = scoreDuplicate(inv({ amount: 260 }), paid({ amount: 240 }))!;
    expect(match.signals).toContain("purchase_order_rebilled");
    expect(match.explanation).toContain("different amount");
  });

  it("catches a duplicate with no purchase order on either side", () => {
    const match = scoreDuplicate(
      inv({ poReference: null }),
      paid({ poReference: null, dueDate: "2026-09-28T00:00:00.000Z" })
    )!;
    expect(match.signals).toEqual(expect.arrayContaining(["same_amount", "same_memo"]));
    expect(match.confidence).toBeGreaterThan(0.8);
  });
});

describe("scoreDuplicate — what it must not flag", () => {
  it("does not flag a monthly recurring charge", () => {
    // The whole reason amount-matching alone is useless: a subscription repeats
    // the vendor, the amount and the wording every single month.
    const october = inv({ poReference: null, dueDate: "2026-10-27T00:00:00.000Z" });
    const september = paid({ poReference: null, dueDate: "2026-09-27T00:00:00.000Z" });
    expect(scoreDuplicate(october, september)).toBeNull();
  });

  it("does not flag a recurring charge across a short month", () => {
    const march = inv({ poReference: null, dueDate: "2026-03-28T00:00:00.000Z" });
    const february = paid({ poReference: null, dueDate: "2026-02-28T00:00:00.000Z" });
    expect(scoreDuplicate(march, february)).toBeNull();
  });

  it("still flags a same-period repeat even without a purchase order", () => {
    // The recurring exemption must not become a loophole: two identical
    // invoices days apart are not a billing cycle.
    const match = scoreDuplicate(
      inv({ poReference: null, dueDate: "2026-09-29T00:00:00.000Z" }),
      paid({ poReference: null, dueDate: "2026-09-27T00:00:00.000Z" })
    );
    expect(match).not.toBeNull();
  });

  it("does not exempt a recurring-looking gap when the purchase order matches", () => {
    // Same PO a month later is not a billing cycle, it is the same order twice.
    const match = scoreDuplicate(
      inv({ dueDate: "2026-10-27T00:00:00.000Z" }),
      paid({ dueDate: "2026-09-27T00:00:00.000Z" })
    );
    expect(match).not.toBeNull();
    expect(match!.signals).toContain("same_purchase_order");
  });

  it("never matches across counterparties", () => {
    // Two vendors invoicing the same amount is a coincidence.
    expect(scoreDuplicate(inv(), paid({ counterpartyId: "cp-other" }))).toBeNull();
  });

  it("does not match an invoice against itself", () => {
    const self = inv();
    expect(scoreDuplicate(self, self)).toBeNull();
  });

  it("does not flag different amounts with no shared purchase order", () => {
    expect(
      scoreDuplicate(inv({ poReference: null, amount: 240 }), paid({ poReference: null, amount: 310 }))
    ).toBeNull();
  });

  it("treats a blank purchase order as absent, not as a match", () => {
    // Two invoices both carrying "" must not count as sharing an order.
    const match = scoreDuplicate(
      inv({ poReference: "", amount: 240, memo: "a", dueDate: "2026-01-01T00:00:00.000Z" }),
      paid({ poReference: "  ", amount: 999, memo: "b", dueDate: "2026-06-01T00:00:00.000Z" })
    );
    expect(match).toBeNull();
  });

  it("compares money at USDC precision rather than by identity", () => {
    expect(scoreDuplicate(inv({ amount: 0.1 + 0.2 }), paid({ amount: 0.3 }))).not.toBeNull();
  });
});

describe("findDuplicates", () => {
  const candidates = [
    paid({ id: "weak", poReference: null, memo: "something else", dueDate: "2026-09-26T00:00:00.000Z" }),
    paid({ id: "strong" }),
    inv({ id: "unrelated", counterpartyId: "cp-other" }),
  ];

  it("returns matches strongest first", () => {
    const matches = findDuplicates(inv(), candidates);
    expect(matches[0].otherId).toBe("strong");
  });

  it("returns nothing on an empty book", () => {
    expect(findDuplicates(inv(), [])).toEqual([]);
  });

  it("ignores invoices belonging to other counterparties", () => {
    expect(findDuplicates(inv(), candidates).map((m) => m.otherId)).not.toContain("unrelated");
  });
});

describe("blockingDuplicate", () => {
  it("selects a high-confidence repeat of settled money", () => {
    const blocker = blockingDuplicate(findDuplicates(inv(), [paid()]));
    expect(blocker?.otherId).toBe("inv-old");
  });

  it("refuses to block on a repeat of an unpaid invoice", () => {
    const matches = findDuplicates(inv(), [inv({ id: "inv-old", status: "pending" })]);
    expect(matches.length).toBeGreaterThan(0);
    expect(blockingDuplicate(matches)).toBeNull();
  });

  it("refuses to block on a weak match", () => {
    const matches = findDuplicates(inv({ amount: 260 }), [paid({ amount: 240 })]);
    expect(matches.length).toBeGreaterThan(0);
    expect(blockingDuplicate(matches)).toBeNull();
  });

  it("returns null when there is nothing to block on", () => {
    expect(blockingDuplicate([])).toBeNull();
  });
});
