import { describe, expect, it } from "vitest";
import {
  addDetailsPrompt,
  addedDetailsSentence,
  addedSince,
  latestDecision,
  missingDetails,
  recordedFacts,
  waitingHint,
} from "@/lib/added-details";

/** What a waiting payable lacks for the three-way match, and what a person added since the decision (complete held invoice). */

const entry = (seq: number, detail: Record<string, unknown>) => ({ seq, detail });

describe("latestDecision", () => {
  it("is the newest entry about the invoice that recorded its facts", () => {
    const entries = [
      entry(12, { invoiceId: "a", added: { poReference: "PO-1" } }),
      entry(11, { invoiceId: "b", observed: { poReference: null } }),
      entry(10, { invoiceId: "a", observed: { poReference: null, goodsReceived: false } }),
      entry(9, { invoiceId: "a", observed: { poReference: "PO-0", goodsReceived: true } }),
    ];
    expect(latestDecision(entries, "a")?.seq).toBe(10);
    expect(latestDecision(entries, "c")).toBeNull();
  });
});

describe("recordedFacts and addedSince", () => {
  it("reads only the facts the decision recorded", () => {
    expect(recordedFacts(entry(1, { observed: { poReference: null, goodsReceived: false } }))).toEqual({ poReference: null, goodsReceived: false });
    expect(recordedFacts(entry(1, { observed: { riskLevel: "clear" } }))).toEqual({});
    expect(recordedFacts(null)).toEqual({});
  });

  it("is what is on file now that the decision recorded as missing", () => {
    expect(addedSince({ poReference: null, goodsReceived: false }, { poReference: "PO-1", goodsReceived: true })).toEqual({ poReference: "PO-1", goodsReceived: true });
    expect(addedSince({ poReference: null, goodsReceived: true }, { poReference: "PO-1", goodsReceived: true })).toEqual({ poReference: "PO-1" });
    expect(addedSince({ poReference: "PO-1", goodsReceived: true }, { poReference: "PO-1", goodsReceived: true })).toBeNull();
    // A decision that recorded neither says nothing was added.
    expect(addedSince({}, { poReference: "PO-1", goodsReceived: true })).toBeNull();
  });
});

describe("what a waiting payable needs", () => {
  it("names what is missing, or nothing", () => {
    expect(missingDetails({ poReference: null, goodsReceived: false })).toEqual({ poReference: true, goodsReceived: true });
    expect(missingDetails({ poReference: "PO-1", goodsReceived: true })).toBeNull();
  });

  it("says it under the row's name, or that details were added", () => {
    expect(waitingHint({ poReference: null, goodsReceived: false }, null)).toBe("Needs a purchase order and goods received");
    expect(waitingHint({ poReference: null, goodsReceived: true }, null)).toBe("Needs a purchase order");
    expect(waitingHint({ poReference: "PO-1", goodsReceived: false }, null)).toBe("Needs goods received");
    expect(waitingHint({ poReference: "PO-1", goodsReceived: true }, null)).toBeUndefined();
    expect(waitingHint({ poReference: "PO-1", goodsReceived: false }, { poReference: "PO-1" })).toBe("Details added · the agent decides it again");
  });

  it("asks for it in the card", () => {
    expect(addDetailsPrompt({ poReference: true, goodsReceived: true })).toBe(
      "Add the purchase order and confirm the goods or services were received, and the agent decides it again."
    );
    expect(addDetailsPrompt({ poReference: true, goodsReceived: false })).toBe("Add the purchase order, and the agent decides it again.");
    expect(addDetailsPrompt({ poReference: false, goodsReceived: true })).toBe("Confirm the goods or services were received, and the agent decides it again.");
  });

  it("says what was added, until the agent decides it again", () => {
    expect(addedDetailsSentence({ goodsReceived: true })).toBe(
      "Since the agent stopped it, the goods were marked received. The agent decides it again at its next cycle, usually within a minute."
    );
  });
});
