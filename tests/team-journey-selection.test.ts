import { describe, expect, it } from "vitest";
import { selectTeamJourneys, type TeamJourney } from "@/lib/team-journey";

const event = { seq: 41, action: "ap_pay", recordedAt: "2026-10-19T10:31:47Z",
  link: { body_hash: "a".repeat(64), signature: "b".repeat(128), prev_hash: "c".repeat(64), hash: "d".repeat(64), signing_key_id: null } };
const direct: TeamJourney = {
  amount: 17.42, currency: "USDC", network: "arc-mainnet", status: "paid",
  received: null, check: event, hold: event, approval: { ...event, seq: 42, action: "approval_paid" }, record: { ...event, seq: 42, action: "approval_paid" },
  observed: { hasPurchaseOrder: null, goodsReceived: null, purchaseOrderRequired: null, riskLevel: null }, rule: "counterparty.new_payee", publicKeys: {},
  payment: { route: "direct", confirmationRecordedAt: "2026-10-19T10:31:44Z",
    source: { chain: "ARC", hash: `0x${"ab".repeat(32)}`, url: `https://explorer.arc.io/tx/0x${"ab".repeat(32)}` },
    destination: { chain: "ARC", hash: `0x${"ab".repeat(32)}`, url: `https://explorer.arc.io/tx/0x${"ab".repeat(32)}` }, feeUsdc: null },
};
const base: TeamJourney = { ...direct, amount: 1, check: { ...event, action: "ap_schedule" },
  decision: { payOn: "2026-10-22", reason: "no_early_payment_discount" },
  payment: { ...direct.payment, route: "cctp", feeUsdc: 0.055026,
    source: { chain: "ARC", hash: `0x${"cd".repeat(32)}`, url: `https://explorer.arc.io/tx/0x${"cd".repeat(32)}` },
    destination: { chain: "BASE", hash: `0x${"ef".repeat(32)}`, url: `https://basescan.org/tx/0x${"ef".repeat(32)}` } } };

describe("selectTeamJourneys", () => {
  it("puts a complete Base story ahead of incomplete direct evidence and keeps the latter separate", () => {
    const incomplete = { ...direct, hold: null, approval: null };
    expect(selectTeamJourneys({ direct: incomplete, base })).toEqual({ primary: base, secondary: incomplete });
  });

  it("puts a complete direct story ahead of incomplete Base evidence", () => {
    const incomplete = { ...base, approval: null };
    expect(selectTeamJourneys({ direct, base: incomplete })).toEqual({ primary: direct, secondary: incomplete });
  });

  it("breaks complete-story ties in favour of Base, without requiring intake or approval-before-confirmation timestamps", () => {
    expect(selectTeamJourneys({ direct, base })).toEqual({ primary: base, secondary: direct });
    const partialReason = { ...base, decision: { payOn: "2026-10-22", reason: null } };
    expect(selectTeamJourneys({ direct, base: partialReason }).primary).toBe(partialReason);
  });

  it.each(["check", "hold", "approval", "record", "rule"] as const)("does not let missing %s mask another complete story", key => {
    const incomplete = { ...base, [key]: null };
    expect(selectTeamJourneys({ direct, base: incomplete }).primary).toBe(direct);
  });

  it("requires renderable decision and hold wording, a schedule day and recorded payment confirmation", () => {
    for (const incomplete of [
      { ...base, decision: null },
      { ...base, check: { ...event, action: "ap_reconcile" } },
      { ...base, rule: "unknown.private_rule" },
      { ...base, payment: { ...base.payment, confirmationRecordedAt: null } },
    ]) expect(selectTeamJourneys({ direct, base: incomplete }).primary).toBe(direct);
  });

  it("uses direct as the honest fallback when neither story is complete", () => {
    const first = { ...direct, approval: null };
    const second = { ...base, hold: null };
    expect(selectTeamJourneys({ direct: first, base: second })).toEqual({ primary: first, secondary: second });
  });

  it("handles single and absent slots without duplicating a secondary payment", () => {
    expect(selectTeamJourneys({ direct, base: null })).toEqual({ primary: direct, secondary: null });
    expect(selectTeamJourneys({ direct: null, base })).toEqual({ primary: base, secondary: null });
    expect(selectTeamJourneys({ direct: null, base: null })).toEqual({ primary: null, secondary: null });
    expect(selectTeamJourneys(null)).toEqual({ primary: null, secondary: null });
  });

  it("does not promote a wrong-route or wrong-destination Base slot", () => {
    for (const payment of [{ ...base.payment, route: "direct" as const }, { ...base.payment, destination: direct.payment.destination }]) {
      expect(selectTeamJourneys({ direct, base: { ...base, payment } })).toEqual({ primary: direct, secondary: null });
    }
  });
});
