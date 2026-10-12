import { describe, expect, it } from "vitest";
import { accountName, bookingPreview } from "@/lib/connectors/booking";

/**
 * The preview before picking the account payments made on Arc will be booked to
 * (docs/superpowers/specs/2026-10-12-xero-connector-design.md X14, I14): USDC as USD, the fee apart, nothing written yet.
 */

const WALLET = { name: "Arc USDC wallet", code: "091", currency: "USD" };

describe("bookingPreview", () => {
  it("shows a bill of the workspace's booked from the account, with the Arc transaction as its reference", () => {
    const preview = bookingPreview(WALLET, { supplier: "PowerDirect", number: "PD-4471", amount: "1250", currency: "USD" }, "Xero");
    expect(preview.lines[0]).toBe(
      "A payment of 1,250.00 USDC to PowerDirect for bill PD-4471 will be booked in Xero as a payment of 1,250.00 USD from Arc USDC wallet (091), with the Arc transaction as its reference."
    );
    expect(preview.lines[1]).toBe("The network fee is shown apart and not booked to this account. Each payment is booked in Xero only after an owner or admin approves it on Bills & receivables.");
    expect(preview.warning).toBeNull();
  });

  it("says it is an example, with a round figure and no supplier, when there is no open bill in US dollars", () => {
    const example =
      "For example, a payment of 100.00 USDC for a bill will be booked in Xero as a payment of 100.00 USD from Arc USDC wallet (091), with the Arc transaction as its reference.";
    expect(bookingPreview(WALLET, null, "Xero").lines[0]).toBe(example);
    // A bill in another currency is not paid as that many USDC, so it would only lend its supplier to a made-up amount.
    expect(bookingPreview(WALLET, { supplier: "Akiba Parts", number: null, amount: "98000", currency: "JPY" }, "Xero").lines[0]).toBe(example);
  });

  it("never previews a payment of nothing: a bill with no amount due is an example instead", () => {
    // A bill paid in Xero has 0.00 due (seen live: "A payment of 0.00 USDC to PowerDirect for bill Rpt").
    for (const amount of ["0", "0.00", "-5", "not a number"]) {
      const line = bookingPreview(WALLET, { supplier: "PowerDirect", number: "Rpt", amount, currency: "USD" }, "Xero").lines[0];
      expect(line).not.toContain("0.00 USDC to");
      expect(line).not.toContain("PowerDirect");
      expect(line).toMatch(/^For example, a payment of 100\.00 USDC for a bill/);
    }
  });

  it("says a USD account fits best when the one picked holds another currency", () => {
    expect(bookingPreview({ name: "UK Account", code: "092", currency: "GBP" }, null, "Xero").warning).toBe(
      "This account holds GBP. A payment in USDC is booked as USD, and one in EURC as EUR, so an account in USD fits it best."
    );
    expect(bookingPreview({ name: "Stablecoin clearing", code: "610", currency: null }, null, "Xero").warning).toBeNull();
  });

  it("names an account with its code when it has one", () => {
    expect(accountName({ name: "Stablecoin clearing", code: null, currency: null })).toBe("Stablecoin clearing");
    expect(accountName(WALLET)).toBe("Arc USDC wallet (091)");
  });
});
