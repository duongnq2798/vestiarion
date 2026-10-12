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

  it("uses a round figure for a bill in another currency, or with no bill at all", () => {
    expect(bookingPreview(WALLET, { supplier: "Akiba Parts", number: null, amount: "98000", currency: "JPY" }, "Xero").lines[0]).toContain(
      "A payment of 1,250.00 USDC to Akiba Parts will be booked"
    );
    expect(bookingPreview(WALLET, null, "Xero").lines[0]).toContain("to a supplier for one of its bills");
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
