import { describe, expect, it } from "vitest";
import { approvalCost } from "@/lib/approval-cost";

/**
 * What Approve and pay would cost, on the approval card (docs/superpowers/specs/2026-10-22-approval-total-cost-design.md
 * TC1-TC3): the invoice, a discount that applies, the route's fee, what leaves, what the payee receives, and Arc's fee.
 */

const NOW = new Date("2026-10-22T12:00:00Z");
const lines = (cost: ReturnType<typeof approvalCost>) => Object.fromEntries(cost.lines.map((line) => [line.label, line.value]));

describe("approvalCost", () => {
  it("for a payee on Arc: the invoice, what leaves the operating wallet and what they receive; on testnet Gas Station pays the network fee", () => {
    const cost = approvalCost({ amount: 140, counterpartyName: "Cobalt Cloud", discount: null, payeeChain: "ARC-TESTNET" }, NOW);
    expect(lines(cost)).toEqual({ Invoice: "140.00 USDC", "Leaves the operating wallet": "140.00 USDC", "Cobalt Cloud receives": "140.00 USDC" });
    expect(cost.lines.find((line) => line.total)?.label).toBe("Leaves the operating wallet");
    expect(cost.note).toBeNull();
  });

  it("notes Arc's network fee on Arc mainnet, whose wallets pay their own gas, for a payee there or on Base", () => {
    const note = "Arc's network fee, about 0.00319 USDC a transaction, also leaves the operating wallet.";
    expect(approvalCost({ amount: 140, counterpartyName: "Cobalt Cloud", discount: null, payeeChain: "ARC" }, NOW).note).toBe(note);
    expect(approvalCost({ amount: 140, counterpartyName: "Cobalt Cloud", discount: null, payeeChain: "BASE", bridgeFeeUsdc: 0.054, payoutRoute: "cctp" }, NOW).note).toBe(note);
    expect(approvalCost({ amount: 140, counterpartyName: "Cobalt Cloud", discount: null, payeeChain: "BASE", bridgeFeeUsdc: 0.05, payoutRoute: "gateway" }, NOW).note).toBeNull();
  });

  it("takes off an early-payment discount while it applies, and not after its deadline", () => {
    const discount = { pct: 2, deadline: "2026-10-25T23:59:59Z" };
    expect(lines(approvalCost({ amount: 100, counterpartyName: "Lumen", discount }, NOW))).toEqual({
      Invoice: "100.00 USDC",
      "Early-payment discount, 2% through Oct 25, 2026": "-2.00 USDC",
      "Leaves the operating wallet": "98.00 USDC",
      "Lumen receives": "98.00 USDC",
    });
    expect(lines(approvalCost({ amount: 100, counterpartyName: "Lumen", discount }, new Date("2026-10-27T00:00:00Z")))["Leaves the operating wallet"]).toBe("100.00 USDC");
  });

  it("adds the CCTP fee for a payee on another chain, who receives at least the amount there", () => {
    const cost = approvalCost({ amount: 140, counterpartyName: "Cobalt Cloud", discount: null, payeeChain: "BASE-SEPOLIA", bridgeFeeUsdc: 0.054604, payoutRoute: "cctp" }, NOW);
    expect(lines(cost)).toEqual({
      Invoice: "140.00 USDC",
      "CCTP fee, about": "0.054604 USDC",
      "Leaves the operating wallet": "140.054604 USDC",
      "Cobalt Cloud receives": "at least 140.00 USDC on Base Sepolia",
    });
  });

  it("pays a Gateway payout and its fee from the Gateway balance, with no network fee note", () => {
    const cost = approvalCost({ amount: 2, counterpartyName: "Harbor", discount: null, payeeChain: "ARB-SEPOLIA", bridgeFeeUsdc: 0.107811, payoutRoute: "gateway" }, NOW);
    expect(lines(cost)).toEqual({ Invoice: "2.00 USDC", "Gateway fee, about": "0.107811 USDC", "Leaves the Gateway balance": "2.107811 USDC", "Harbor receives": "2.00 USDC on Arbitrum Sepolia" });
    expect(cost.note).toBeNull();
  });

  it("says when the fee was not read, without adding a guess", () => {
    expect(lines(approvalCost({ amount: 5, counterpartyName: "Harbor", discount: null, payeeChain: "BASE-SEPOLIA", bridgeFeeUsdc: null, payoutRoute: "cctp" }, NOW))).toMatchObject({
      "CCTP fee, about": "not read just now",
      "Leaves the operating wallet": "5.00 USDC and the fee",
    });
  });

  it("states a EURC invoice in EURC", () => {
    expect(lines(approvalCost({ amount: 1.9, counterpartyName: "Atelier", currency: "EURC", discount: null }, NOW))).toEqual({
      Invoice: "1.90 EURC",
      "Leaves the operating wallet": "1.90 EURC",
      "Atelier receives": "1.90 EURC",
    });
  });
});
