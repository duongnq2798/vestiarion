import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TrackRecordView } from "@/components/TrackRecordView";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { TrackRecord } from "@/lib/track-record/build";

/**
 * The track record's page (docs/superpowers/specs/2026-11-07-track-record-design.md TR6, TR7, TR9): the totals, the
 * ladder, the earned vendors in the report's words, each verdict with its entries, the record's SHA-256, and the
 * confirmations, each said to be this record or an earlier one. It says it only measures.
 */

const SHA = "ab".repeat(32);

const RECORD: TrackRecord = {
  workspace: { slug: "acme-shadow", name: "Acme Shadow" },
  network: "arc-testnet",
  readAt: "2026-11-07T09:00:00.000Z",
  ledgerHead: { seq: 812, hash: "f".repeat(64) },
  totals: { given: 6, agreed: 5, disagreed: 1 },
  byKind: [{ key: "ap_pay", label: "Pay", given: 6, agreed: 5, disagreed: 1, rate: 83, enough: true }],
  byVendor: [{ key: "cp-1", label: "Firm Studio", given: 6, agreed: 5, disagreed: 1, rate: 83, enough: true }],
  earned: {
    streak: 5,
    payments: true,
    vendors: [{ vendorId: "cp-1", name: "Firm Studio", state: "earned", shownEarned: true, words: "Earned: 5 agreed in a row, Oct 20, 2026 to Oct 28, 2026", waiting: null }],
  },
  verdicts: [
    {
      decisionSeq: 41,
      decidedAt: "2026-10-20T09:00:00.000Z",
      action: "ap_pay",
      kind: "Pay",
      vendor: { id: "cp-1", name: "Firm Studio" },
      amount: 9.8,
      currency: "USDC",
      verdict: "disagree",
      givenAt: null,
      verdictSeq: 44,
    },
  ],
  cut: false,
  confirmations: [
    { seq: 810, at: "2026-11-06T09:00:00.000Z", by: "u-1", who: "books@example.com", sha256: SHA, current: true },
    { seq: 700, at: "2026-11-01T09:00:00.000Z", by: "u-2", who: null, sha256: "cd".repeat(32), current: false },
  ],
  contentSha256: SHA,
  keys: [],
  entries: [],
};

const render = (record: TrackRecord | null) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <TrackRecordView record={record} download="/api/evidence/track-record?org=acme-shadow" confirm={<p>CONFIRM</p>} />
    </TooltipProvider>
  );

describe("TrackRecordView", () => {
  it("shows the totals, the ladder, the earned vendors and each verdict with its entries", () => {
    const html = render(RECORD);
    expect(html).toContain("It only measures: it promises nothing about payments to come.");
    expect(html).toContain("How often you agreed, by decision and by vendor");
    expect(html).toContain("Earned: 5 agreed in a row, Oct 20, 2026 to Oct 28, 2026");
    expect(html).toContain("The agent pays an earned vendor on its own, and a person gives a verdict after.");
    expect(html).toContain("Disagreed");
    expect(html).toContain("#0041, #0044");
    expect(html).toContain("9.80 USDC");
  });

  it("shows the record's SHA-256, its download and Confirm, and the confirmations against it", () => {
    const html = render(RECORD);
    expect(html).toContain(SHA);
    expect(html).toContain('href="/api/evidence/track-record?org=acme-shadow"');
    expect(html).toContain("CONFIRM");
    expect(html).toContain("Nov 6, 2026, by books@example.com");
    expect(html).toContain("This record");
    expect(html).toContain("Nov 1, 2026, by a member");
    expect(html).toContain("An earlier record");
    expect(html).toContain("at ledger entry #0812");
  });

  it("says when there is no verdict yet, or no confirmation, and never calls it a score", () => {
    const html = render({ ...RECORD, totals: { given: 0, agreed: 0, disagreed: 0 }, byKind: [], byVendor: [], verdicts: [], confirmations: [] });
    expect(html).toContain("No verdict on a real bill yet, so there is nothing to confirm.");
    expect(html).toContain("No accountant has confirmed a track record of this workspace yet.");
    expect(render(RECORD).toLowerCase()).not.toMatch(/\bscore\b|\brating\b/);
    expect(render(null)).toBe("");
  });
});
