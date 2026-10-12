import { describe, expect, it } from "vitest";
import {
  dealCurrency,
  dealDigits,
  formatMinor,
  MAX_TOTAL_MINOR,
  minorToDecimal,
  minorToNumber,
  parseMinor,
} from "@/lib/deals/money";

/**
 * A deal's money is kept in minor units (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D2, D3): cents for
 * USDC, EURC and two-decimal currencies, whole units for currencies without minor units, such as the yen and the won.
 */

describe("dealDigits", () => {
  it("is two for USDC, EURC and two-decimal currencies, none for the yen and the won", () => {
    expect(dealDigits("USDC")).toBe(2);
    expect(dealDigits("EURC")).toBe(2);
    expect(dealDigits("EUR")).toBe(2);
    expect(dealDigits("JPY")).toBe(0);
    expect(dealDigits("krw")).toBe(0);
  });
});

describe("dealCurrency", () => {
  it("takes USDC and EURC anywhere, in any case", () => {
    expect(dealCurrency("usdc", { shadowOn: false })).toBe("USDC");
    expect(dealCurrency(" EURC ", { shadowOn: false })).toBe("EURC");
  });

  it("takes another three-letter code only in shadow mode", () => {
    expect(dealCurrency("EUR", { shadowOn: false })).toBeNull();
    expect(dealCurrency("eur", { shadowOn: true })).toBe("EUR");
    expect(dealCurrency("JPY", { shadowOn: true })).toBe("JPY");
  });

  it("never takes VND, nor anything that is not a code", () => {
    expect(dealCurrency("VND", { shadowOn: true })).toBeNull();
    expect(dealCurrency("vnd", { shadowOn: false })).toBeNull();
    expect(dealCurrency("US", { shadowOn: true })).toBeNull();
    expect(dealCurrency("", { shadowOn: true })).toBeNull();
  });
});

describe("parseMinor", () => {
  it("reads an amount as written into minor units", () => {
    expect(parseMinor("10000", "USDC")).toBe(1_000_000);
    expect(parseMinor("1,250.50", "USDC")).toBe(125_050);
    expect(parseMinor("1.250,50", "EUR")).toBe(125_050);
    expect(parseMinor("0.01", "EURC")).toBe(1);
  });

  it("reads whole units for a currency without minor units", () => {
    expect(parseMinor("1,000,000", "JPY")).toBe(1_000_000);
    expect(parseMinor("2500000", "KRW")).toBe(2_500_000);
    expect(parseMinor("100.50", "JPY")).toBeNull();
  });

  it("refuses zero, more than two decimals, text and an amount over the limit", () => {
    expect(parseMinor("0", "USDC")).toBeNull();
    expect(parseMinor("1.005", "USDC")).toBeNull();
    expect(parseMinor("ten", "USDC")).toBeNull();
    expect(parseMinor("", "USDC")).toBeNull();
    expect(parseMinor("100000000000000", "USDC")).toBeNull();
    expect(parseMinor(String(MAX_TOTAL_MINOR), "JPY")).toBe(MAX_TOTAL_MINOR);
  });

  it("can take zero where a line may be removed", () => {
    expect(parseMinor("0", "USDC", { allowZero: true })).toBe(0);
  });
});

describe("minor units back to words", () => {
  it("gives the decimal an invoice takes", () => {
    expect(minorToDecimal(125_050, 2)).toBe("1250.50");
    expect(minorToDecimal(7, 2)).toBe("0.07");
    expect(minorToDecimal(-150, 2)).toBe("-1.50");
    expect(minorToDecimal(1_000_000, 0)).toBe("1000000");
  });

  it("formats with grouping and the currency's decimals", () => {
    expect(formatMinor(125_050, 2)).toBe("1,250.50");
    expect(formatMinor(1_000_000, 0)).toBe("1,000,000");
    expect(formatMinor(-100, 2)).toBe("-1.00");
  });

  it("gives a number for figures that add amounts", () => {
    expect(minorToNumber(125_050, 2)).toBe(1250.5);
    expect(minorToNumber(333_333, 0)).toBe(333_333);
  });
});
