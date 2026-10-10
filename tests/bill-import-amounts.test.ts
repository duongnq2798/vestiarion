import { describe, expect, it } from "vitest";
import { billAmount } from "@/lib/bill-amount";
import { currencyDigits, decimalKey, decimalMarkOf, isCurrencyCode, readAmount, splitCurrency, symbolFits } from "@/lib/bill-import/amounts";

const value = (text: string, mark: "." | "," | null, currency: string) => {
  const read = readAmount(text, mark, currency);
  return read.ok ? read.value : read.reason;
};

describe("currencyDigits", () => {
  it("gives USDC and EURC 6 decimals, the yen and the won none, and other currencies 2 (I07)", () => {
    expect(currencyDigits("USDC")).toBe(6);
    expect(currencyDigits("eurc")).toBe(6);
    expect(currencyDigits("JPY")).toBe(0);
    expect(currencyDigits("KRW")).toBe(0);
    expect(currencyDigits("SGD")).toBe(2);
    expect(currencyDigits("PHP")).toBe(2);
    expect(currencyDigits("MYR")).toBe(2);
    expect(currencyDigits("USD")).toBe(2);
  });
});

describe("splitCurrency", () => {
  it.each([
    ["$1,200.00", "1,200.00", "$", ["USD", "SGD", "AUD", "CAD", "HKD", "NZD", "TWD", "MXN"]],
    ["US$ 1,200", "1,200", "US$", ["USD"]],
    ["S$1,200.50", "1,200.50", "S$", ["SGD"]],
    ["RM 1,200.50", "1,200.50", "RM", ["MYR"]],
    ["₱12,500.00", "12,500.00", "₱", ["PHP"]],
    ["₩1,250,000", "1,250,000", "₩", ["KRW"]],
    ["¥120,000", "120,000", "¥", ["JPY", "CNY"]],
    ["120,000円", "120,000", "円", ["JPY"]],
    ["1.234,50 €", "1.234,50", "€", ["EUR"]],
    ["JPY 120,000", "120,000", "JPY", ["JPY"]],
    ["120000 jpy", "120000", "JPY", ["JPY"]],
    ["100.5 USDC", "100.5", "USDC", ["USDC"]],
    ["1,200.00", "1,200.00", null, null],
    ["abc", "abc", null, null],
  ])("splits %s", (cell, number, mark, codes) => {
    expect(splitCurrency(cell)).toEqual({ number, mark, codes });
  });
});

describe("symbolFits", () => {
  it("lets a dollar sign stand for USDC, a euro sign for EURC, and a code for itself", () => {
    expect(symbolFits(splitCurrency("$5").codes, "USDC")).toBe(true);
    expect(symbolFits(splitCurrency("€5").codes, "EURC")).toBe(true);
    expect(symbolFits(splitCurrency("¥5").codes, "JPY")).toBe(true);
    expect(symbolFits(splitCurrency("S$5").codes, "SGD")).toBe(true);
    expect(symbolFits(splitCurrency("₩5").codes, "USDC")).toBe(false);
    expect(symbolFits(splitCurrency("€5").codes, "USDC")).toBe(false);
    expect(symbolFits(null, "USDC")).toBe(true);
  });
});

describe("decimalMarkOf", () => {
  const cells = (...texts: string[]) => texts.map((text) => ({ text, currency: "USDC" }));

  it("reads the decimal mark from a cell with both marks", () => {
    expect(decimalMarkOf(cells("1,234.50", "1234"))).toEqual({ mark: ".", ask: false, mixed: false });
    expect(decimalMarkOf(cells("1.234,50", "1234"))).toEqual({ mark: ",", ask: false, mixed: false });
  });

  it("reads a mark followed by other than three digits as the decimal mark, and a repeated mark as grouping", () => {
    expect(decimalMarkOf(cells("12,5"))).toEqual({ mark: ",", ask: false, mixed: false });
    expect(decimalMarkOf(cells("0.123"))).toEqual({ mark: ".", ask: false, mixed: false });
    expect(decimalMarkOf(cells("1.234.567"))).toEqual({ mark: ",", ask: false, mixed: false });
    expect(decimalMarkOf(cells("1 234,50"))).toEqual({ mark: ",", ask: false, mixed: false });
  });

  it("asks when a mark followed by three digits is all there is", () => {
    expect(decimalMarkOf(cells("1,234", "500"))).toEqual({ mark: null, ask: true, mixed: false });
  });

  it("reads a three-digit group in a currency without decimals as thousands", () => {
    expect(decimalMarkOf([{ text: "120,000", currency: "JPY" }])).toEqual({ mark: ".", ask: false, mixed: false });
    expect(decimalMarkOf([{ text: "1.250.000", currency: "KRW" }, { text: "120.000", currency: "KRW" }])).toEqual({ mark: ",", ask: false, mixed: false });
  });

  it("asks when cells disagree", () => {
    expect(decimalMarkOf(cells("1,234.50", "1.234,50"))).toEqual({ mark: null, ask: true, mixed: true });
  });

  it("needs nothing for whole numbers", () => {
    expect(decimalMarkOf(cells("1200", "35"))).toEqual({ mark: null, ask: false, mixed: false });
  });
});

describe("readAmount", () => {
  it("reads an amount in the list's own number format, exactly", () => {
    expect(value("1,234.50", ".", "USDC")).toBe("1234.5");
    expect(value("1.234,50", ",", "EURC")).toBe("1234.5");
    expect(value("1 234,50", ",", "USDC")).toBe("1234.5");
    expect(value("1'234.50", ".", "USDC")).toBe("1234.5");
    expect(value("1,234.567891", ".", "USDC")).toBe("1234.567891");
    expect(value("12345678901234.123456", ".", "USDC")).toBe("12345678901234.123456");
    expect(value("0.000001", ".", "USDC")).toBe("0.000001");
    expect(value("007", null, "USDC")).toBe("7");
  });

  it("reads a cell that settles its own mark when the list has none", () => {
    expect(value("1,234.50", null, "USDC")).toBe("1234.5");
    expect(value("12,5", null, "USDC")).toBe("12.5");
    expect(value("1,234", null, "USDC")).toBe("could be read two ways: say how the list writes its amounts");
  });

  it("refuses a cell that does not fit the list's mark", () => {
    expect(value("1.234,50", ".", "USDC")).toBe("does not fit the list's amounts, written like 1,234.50");
    expect(value("1,234.50", ",", "USDC")).toBe("does not fit the list's amounts, written like 1.234,50");
    expect(value("1,23,4", ".", "USDC")).toBe("is not a number");
  });

  it("takes no decimals in the yen or the won, though trailing zeros read as the whole number (I07)", () => {
    expect(value("120,000", ".", "JPY")).toBe("120000");
    expect(value("1.250.000", ",", "KRW")).toBe("1250000");
    expect(value("12000.00", ".", "JPY")).toBe("12000");
    expect(value("1,500.5", ".", "JPY")).toBe("has decimals, and JPY amounts are whole numbers");
    expect(value("1500,5", ",", "KRW")).toBe("has decimals, and KRW amounts are whole numbers");
  });

  it("takes at most 2 decimals in a currency with cents, and 6 in USDC", () => {
    expect(value("1,200.505", ".", "SGD")).toBe("has more than 2 decimals, the most SGD takes");
    expect(value("1.0000001", ".", "USDC")).toBe("has more than 6 decimals, the most USDC takes");
  });

  it("refuses zero, a negative amount, a bracketed one, a blank and text", () => {
    expect(value("0.00", ".", "USDC")).toBe("is not above zero");
    expect(value("-50", ".", "USDC")).toBe("is negative: a credit note is not a bill");
    expect(value("(50.00)", ".", "USDC")).toBe("is negative: a credit note is not a bill");
    expect(value("", ".", "USDC")).toBe("is blank");
    expect(value("twelve", ".", "USDC")).toBe("is not a number");
    expect(value("123456789012345", ".", "USDC")).toBe("is too large");
  });

  it("gives a bill's own amount that the shadow path reads back to the same number", () => {
    for (const [text, mark, currency] of [["120,000", ".", "JPY"], ["1.234,56", ",", "EUR"], ["S$ 9,999.99", ".", "SGD"]] as const) {
      const read = readAmount(splitCurrency(text).number, mark, currency);
      if (!read.ok) throw new Error(read.reason);
      expect(String(billAmount(read.value, currency))).toBe(read.value);
    }
  });
});

describe("decimalKey and isCurrencyCode", () => {
  it("compares amounts as exact decimals, whatever their form", () => {
    expect(decimalKey("1234.500000")).toBe("1234.5");
    expect(decimalKey(1234.5)).toBe("1234.5");
    expect(decimalKey("0010.0")).toBe("10");
    expect(decimalKey(0.000001)).toBe("0.000001");
  });

  it("knows the ISO 4217 codes and the two stablecoins", () => {
    expect(isCurrencyCode("JPY")).toBe(true);
    expect(isCurrencyCode("USDC")).toBe(true);
    expect(isCurrencyCode("EURC")).toBe(true);
    expect(isCurrencyCode("XYZ")).toBe(false);
    expect(isCurrencyCode("dollars")).toBe(false);
  });
});
