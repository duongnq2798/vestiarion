import { describe, expect, it } from "vitest";
import { teamJourneyView } from "@/lib/team-journey";

const burn = `0x${"ab".repeat(32)}`;
const mint = `0x${"cd".repeat(32)}`;
const link = { body_hash: "a".repeat(64), signature: "b".repeat(128), prev_hash: "c".repeat(64), hash: "d".repeat(64), signing_key_id: null };
const event = { seq: 21, recordedAt: "2026-10-07T09:43:17Z", action: "approval_paid", link };
const facts = {
  amount: "0.1", currency: "USDC", network: "arc-mainnet", status: "paid",
  received: null, check: null, hold: null, approval: event, record: event,
  observed: { hasPurchaseOrder: true, goodsReceived: true, purchaseOrderRequired: true, riskLevel: "clear" },
  rule: "counterparty.new_payee",
  payment: { route: "direct", confirmationRecordedAt: "2026-10-07T09:43:13Z", txHash: burn, mintTxHash: null, destinationChain: "ARC", feeUsdc: null },
};

describe("teamJourneyView", () => {
  it("uses the actual payment amount and labels ledger recording time without rewriting chronology", () => {
    const shown = teamJourneyView({ ...facts, invoiceAmount: 9000 }, { public: "PEM" });
    expect(shown).toMatchObject({ amount: 0.1, currency: "USDC", approval: event, publicKeys: { public: "PEM" } });
    expect(shown?.payment.confirmationRecordedAt).toBe("2026-10-07T09:43:13Z");
    expect(shown?.received).toBeNull();
    expect(shown?.payment.source.url).toBe(`https://explorer.arc.io/tx/${burn}`);
    expect(shown?.payment.destination).toEqual(shown?.payment.source);
    expect(shown).not.toHaveProperty("invoiceAmount");
  });

  it("links the Arc burn and Base mint separately, and refuses an unminted or wrong-network payout", () => {
    const cross = { ...facts, payment: { ...facts.payment, route: "cctp", destinationChain: "BASE", mintTxHash: mint, feeUsdc: "0.01" } };
    const shown = teamJourneyView(cross, {});
    expect(shown?.payment.source.url).toBe(`https://explorer.arc.io/tx/${burn}`);
    expect(shown?.payment.destination.url).toBe(`https://basescan.org/tx/${mint}`);
    expect(shown?.payment.feeUsdc).toBe(0.01);
    expect(teamJourneyView({ ...cross, payment: { ...cross.payment, mintTxHash: null } }, {})).toBeNull();
    expect(teamJourneyView({ ...cross, network: "arc-testnet" }, {})).toBeNull();
    expect(teamJourneyView({ ...cross, payment: { ...cross.payment, destinationChain: "BASE-SEPOLIA" } }, {})).toBeNull();
    expect(teamJourneyView({ ...cross, currency: "EURC" }, {})).toBeNull();
  });

  it("keeps malformed/missing event facts unknown and never passes private extras or arbitrary markers", () => {
    const shown = teamJourneyView({ ...facts, orgId: "private-id", summary: "private summary", received: { ...event, recordedAt: "not-a-date" },
      check: { ...event, action: "ap_pay", detail: { private: "secret" } },
      observed: { riskLevel: "private explanation", goodsReceived: null, hasPurchaseOrder: null, purchaseOrderRequired: null, poReference: "SECRET-PO" }, rule: "a person's private reason" }, {});
    expect(shown?.received).toBeNull();
    expect(shown?.observed.riskLevel).toBeNull();
    expect(shown?.rule).toBeNull();
    expect(JSON.stringify(shown)).not.toMatch(/private|SECRET|detail|summary|orgId/);
    expect(teamJourneyView({ ...facts, payment: { ...facts.payment, confirmationRecordedAt: null } }, {})?.payment.confirmationRecordedAt).toBeNull();
  });

  it("refuses non-paid statuses, invalid hashes/amounts/currency and never invents a signed event", () => {
    for (const update of [{ status: "pending" }, { amount: null }, { amount: -1 }, { currency: "private text" }, { payment: { ...facts.payment, txHash: "circle-id" } }]) {
      expect(teamJourneyView({ ...facts, ...update }, {})).toBeNull();
    }
    expect(teamJourneyView({ ...facts, record: { ...event, link: { ...link, signature: "broken" } } }, {})?.record).toBeNull();
  });
});
