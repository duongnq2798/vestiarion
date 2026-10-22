import { describe, expect, it } from "vitest";
import { receiptAmounts } from "@/lib/receipts/amounts";
import type { ReceiptFacts } from "@/lib/receipts/facts";

/**
 * A receipt's Amounts list (docs/superpowers/specs/2026-10-22-receipt-v2-design.md RV3, RV4): the invoice and its
 * number, what a discount took off, each fee and who paid it, what left the sender, and what the payee received.
 */

const PAYEE = "0x221b000000000000000000000000000000001bc3";
const TX = `0x${"3".repeat(64)}`;
const direct: ReceiptFacts = { amount: 98, token: "USDC", paidAt: "", payee: PAYEE, chain: "ARC-TESTNET", txHash: TX, route: "direct", feesPaidBy: "sender" };
const rows = (facts: ReceiptFacts, onChain: Parameters<typeof receiptAmounts>[1] = { state: "matches", block: 1, received: facts.amount }) =>
  Object.fromEntries(receiptAmounts(facts, onChain).map((row) => [row.label, row.value]));

describe("a receipt's amounts", () => {
  it("names the invoice, what a discount took off, the network fee, who paid it, what left and what arrived", () => {
    expect(rows({ ...direct, invoiceNumber: "INV-2207", invoiceAmount: 100, networkFeeUsdc: 0.003214 })).toEqual({
      Invoice: "INV-2207",
      "Invoice amount": "100 USDC, less 2 USDC for paying early",
      "Amount paid": "98 USDC",
      "Arc testnet network fee": "0.003214 USDC",
      "Fees paid by": "The sender, on top of the amount. No fee was taken from the payee's payment.",
      "Left the sender": "98.003214 USDC",
      "Payee received": "98 USDC, read on Arc testnet",
    });
  });

  it("gives a CCTP fee as the most it could be, and what the payee received above the amount", () => {
    const cctp: ReceiptFacts = { ...direct, amount: 2, chain: "BASE-SEPOLIA", route: "cctp", feeUsdc: 0.054604 };
    expect(rows(cctp, { state: "matches", block: 1, received: 2.0003 })).toMatchObject({
      "CCTP fee": "up to 0.054604 USDC",
      "Left the sender": "2.054604 USDC, and Arc testnet's network fee",
      "Payee received": "2.0003 USDC, read on Base Sepolia",
    });
    expect(rows({ ...cctp, route: "gateway", chain: "ARB-SEPOLIA", feeUsdc: 0.107811 })).toMatchObject({ "Gateway fee": "0.107811 USDC" });
  });

  it("states the amount while the chain does not answer, and nothing received when the transfer does not match", () => {
    expect(rows(direct, { state: "unreadable" })["Payee received"]).toBe("98 USDC, as stated: Arc testnet did not answer just now");
    expect(rows(direct, { state: "mismatch", reason: "no" })["Payee received"]).toBeUndefined();
  });

  it("adds no total for a EURC payment, whose fees are in USDC", () => {
    expect(rows({ ...direct, token: "EURC", networkFeeUsdc: 0.003 })["Left the sender"]).toBeUndefined();
  });

  it("shows a receipt shared before receipts v2 as it stated it: what was paid and received", () => {
    const { feesPaidBy: _left, ...before } = direct;
    void _left;
    expect(rows({ ...before, chain: "ARB-SEPOLIA", route: "gateway", feeUsdc: 0.1 })).toEqual({ "Amount paid": "98 USDC", "Payee received": "98 USDC, read on Arbitrum Sepolia" });
  });
});
