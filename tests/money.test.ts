import { describe, expect, it } from "vitest";
import {
  addMoney,
  atDigits,
  convertMoney,
  CurrencyMismatchError,
  decimalOf,
  divRound,
  formatMoney,
  formatRateValue,
  fullProvenance,
  fxVariance,
  money,
  moneyDigits,
  moneyOf,
  numberOf,
  pegRate,
  provenanceShare,
  rateAtPayment,
  rateAge,
  rateBook,
  rateValue,
  rateWords,
  ratio,
  referenceRate,
  reportingTotals,
  roundedMoney,
  SIX_CURRENCIES,
  sumMoney,
  toReporting,
  totalsByCurrency,
  type FxRate,
  type Money,
  type MoneyFigure,
} from "@/lib/money";

/**
 * The canonical money shape (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M1-M6): minor units in
 * bigint, exact round trips and totals for the six currencies (JPY and KRW at no decimals, the others at two), rates
 * that say their kind, and conversions rounded once.
 */

/** A small deterministic generator, so the property runs are the same on every machine. */
function generator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}
const random = generator(20_261_013);
const integer = (max: number) => Math.floor(random() * max);
/** Minor units up to 10^13: well past any bill, within a safe integer. */
const someMinor = () => BigInt(integer(10_000_000)) * BigInt(1_000_000) + BigInt(integer(1_000_000));

const AT = "2026-10-13T00:02:31.000Z";
const usd = (currency: string, perUsd: string, at = AT) => referenceRate(currency, perUsd, "ExchangeRate-API", at) as FxRate;

describe("moneyDigits", () => {
  it("keeps none for the yen and the won, two for the other four of the six, six for the tokens", () => {
    expect(SIX_CURRENCIES.map((currency) => [currency, moneyDigits(currency)])).toEqual([
      ["USD", 2], ["SGD", 2], ["JPY", 0], ["KRW", 0], ["PHP", 2], ["MYR", 2],
    ]);
    expect(moneyDigits("EUR")).toBe(2);
    expect(moneyDigits("usdc")).toBe(6);
    expect(moneyDigits("EURC")).toBe(6);
  });
});

describe("round trips for the six currencies", () => {
  it.each(SIX_CURRENCIES)("%s: minor units to text and back are exact, 2,000 times", (currency) => {
    for (let run = 0; run < 2000; run += 1) {
      const amount = money(someMinor(), currency);
      expect(moneyOf(decimalOf(amount), currency)).toEqual(amount);
      expect(roundedMoney(decimalOf(amount), currency)).toEqual(amount);
      // Through a JavaScript number, as PostgREST hands back numeric(24, 6): exact below 2^53 minor units.
      expect(roundedMoney(numberOf(amount), currency)).toEqual(amount);
    }
  });

  it.each(SIX_CURRENCIES)("%s: a total is the sum of its parts in any order, and splits back exactly", (currency) => {
    for (let run = 0; run < 200; run += 1) {
      const parts = Array.from({ length: 1 + integer(30) }, () => money(BigInt(integer(100_000_000)), currency));
      const total = sumMoney(currency, parts);
      expect(sumMoney(currency, [...parts].reverse())).toEqual(total);
      // The same total as numbers would drift; in minor units it does not.
      const asDecimals = parts.map((part) => decimalOf(part));
      expect(sumMoney(currency, asDecimals.map((text) => moneyOf(text, currency) as Money))).toEqual(total);
    }
  });

  it("refuses more decimals than the currency keeps, rather than drop them", () => {
    expect(moneyOf("100.5", "JPY")).toBeNull();
    expect(moneyOf("1250.505", "SGD")).toBeNull();
    expect(moneyOf("1250.50", "SGD")).toEqual(money(125_050, "SGD"));
    expect(moneyOf("150000", "KRW")).toEqual(money(150_000, "KRW"));
    expect(moneyOf("0.000001", "USDC")).toEqual(money(1, "USDC"));
    expect(moneyOf("1,250.50", "SGD")).toBeNull();
  });

  it("rounds a value read with more digits half away from zero, once", () => {
    expect(roundedMoney("1250.505", "SGD")).toEqual(money(125_051, "SGD"));
    expect(roundedMoney("1250.504999", "SGD")).toEqual(money(125_050, "SGD"));
    expect(roundedMoney("-0.005", "USD")).toEqual(money(-1, "USD"));
    expect(roundedMoney("149999.5", "JPY")).toEqual(money(150_000, "JPY"));
    expect(roundedMoney(1209.8786, "USDC")).toEqual(money(1_209_878_600, "USDC"));
    expect(roundedMoney(1e-7, "USDC")).toEqual(money(0, "USDC"));
    expect(roundedMoney(0.1 + 0.2, "USD")).toEqual(money(30, "USD"));
  });

  it("never adds two currencies", () => {
    expect(() => addMoney(money(1, "USD"), money(1, "USDC"))).toThrow(CurrencyMismatchError);
    expect(() => sumMoney("SGD", [money(1, "SGD"), money(1, "MYR")])).toThrow(CurrencyMismatchError);
  });

  it("totals per currency, in currency order, counting each", () => {
    const totals = totalsByCurrency([money(500, "SGD"), money(150_000, "JPY"), money(250, "SGD"), money(1_000_000, "USDC")]);
    expect(totals.map(({ total, count }) => [formatMoney(total), count])).toEqual([
      ["150,000 JPY", 1],
      ["7.50 SGD", 2],
      ["1.00 USDC", 1],
    ]);
  });
});

describe("formatMoney", () => {
  it("writes each currency's own digits, a token at least two and only what it has beyond", () => {
    expect(formatMoney(money(125_050, "SGD"))).toBe("1,250.50 SGD");
    expect(formatMoney(money(1_500_000, "KRW"))).toBe("1,500,000 KRW");
    expect(formatMoney(money(1_000_000_000, "USDC"))).toBe("1,000.00 USDC");
    expect(formatMoney(money(1_209_878_600, "USDC"))).toBe("1,209.8786 USDC");
    expect(formatMoney(money(-735_000, "USDC"), { code: false })).toBe("-0.735");
    expect(formatMoney(money(735, "USD"), { sign: true })).toBe("+7.35 USD");
  });
});

describe("divRound and atDigits", () => {
  it("rounds half away from zero, in both signs", () => {
    expect(divRound(BigInt(5), BigInt(2))).toBe(BigInt(3));
    expect(divRound(BigInt(-5), BigInt(2))).toBe(BigInt(-3));
    expect(divRound(BigInt(4), BigInt(3))).toBe(BigInt(1));
    expect(atDigits(BigInt(125_050), 2, 6)).toBe(BigInt(1_250_500_000));
    expect(atDigits(BigInt(1_250_505_000), 6, 2)).toBe(BigInt(125_051));
  });
});

describe("rates", () => {
  it("reads a rate exactly, trailing zeros dropped, and never zero or negative", () => {
    expect(rateValue(1.35)).toBe("1.35");
    expect(rateValue("1380.250000")).toBe("1380.25");
    expect(rateValue("0")).toBeNull();
    expect(rateValue("-1.2")).toBeNull();
    expect(rateValue("1.0000000000001")).toBeNull();
    expect(ratio("1.35")).toEqual({ num: BigInt(135), den: BigInt(100) });
  });

  it("names its kind, source and time wherever it is said", () => {
    expect(rateWords(usd("SGD", "1.35"))).toBe("1 USD = 1.3500 SGD, reference rate from ExchangeRate-API, published 13 Oct 2026, 00:02 UTC");
    expect(rateWords(pegRate("USDC"))).toBe("1 USDC = 1 USD, redemption peg (USDC's 1:1 dollar redemption), not a market rate");
    expect(formatRateValue("1380.2512")).toBe("1,380.2512");
  });

  it("says a stored rate's age beside its time, when the reader's time is given", () => {
    expect(rateWords(usd("SGD", "1.35"), { now: "2026-10-13T12:00:00.000Z" })).toBe(
      "1 USD = 1.3500 SGD, reference rate from ExchangeRate-API, published 13 Oct 2026, 00:02 UTC, 11 hours old"
    );
    // A peg has no time, so no age.
    expect(rateWords(pegRate("USDC"), { now: "2026-10-13T12:00:00.000Z" })).toBe(rateWords(pegRate("USDC")));
    expect(rateAge("2026-10-13T00:02:00.000Z", "2026-10-13T00:40:00.000Z")).toBe("under an hour old");
    expect(rateAge("2026-10-13T00:02:00.000Z", "2026-10-13T01:10:00.000Z")).toBe("1 hour old");
    expect(rateAge("2026-10-11T00:02:00.000Z", "2026-10-13T12:00:00.000Z")).toBe("2 days old");
    expect(rateAge("not a time", "2026-10-13T12:00:00.000Z")).toBe("age not known");
  });

  it.each(SIX_CURRENCIES.filter((currency) => currency !== "USD"))("converts %s to the dollar and back within one minor unit of each side", (currency) => {
    const rate = usd(currency, { SGD: "1.3512", JPY: "149.235", KRW: "1380.25", PHP: "56.8121", MYR: "4.4725" }[currency] as string);
    for (let run = 0; run < 500; run += 1) {
      const amount = money(BigInt(1 + integer(1_000_000_000)), currency);
      const dollars = convertMoney(amount, [rate], "USD");
      const back = convertMoney(dollars, [rate], currency);
      // A dollar cent is worth up to 14 won or 57 centavos: the round trip is as close as the dollar's cents allow, half
      // a cent either way, never further.
      const tolerance = BigInt(Math.ceil((Number(rate.value) * 10 ** moneyDigits(currency)) / 200)) + BigInt(1);
      const gap = back.minor - amount.minor;
      expect(gap <= tolerance && -gap <= tolerance, `${decimalOf(amount)} ${currency} came back as ${decimalOf(back)}`).toBe(true);
    }
  });

  it("goes through several rates as one fraction, rounded once", () => {
    // 1,000.00 SGD to yen through the dollar: 1000 / 1.35 * 149.235 = 110,544.44… yen, rounded once.
    const yen = convertMoney(money(100_000, "SGD"), [usd("SGD", "1.35"), usd("JPY", "149.235")], "JPY");
    expect(yen).toEqual(money(110_544, "JPY"));
  });

  it("refuses a chain that does not connect", () => {
    expect(() => convertMoney(money(100, "SGD"), [usd("JPY", "149")], "JPY")).toThrow(/does not apply/);
  });
});

describe("reporting totals", () => {
  const book = rateBook([usd("SGD", "1.35"), usd("JPY", "150"), usd("EUR", "0.9")], { KRW: "The last KRW rate recorded is from 2 Oct 2026, too old to report with." });

  it("keeps an amount in the reporting currency as it is", () => {
    expect(toReporting(money(500, "SGD"), "SGD", book)).toEqual({ state: "same", money: money(500, "SGD") });
  });

  it("reaches the dollar from USDC by the peg, said as a rate, never silently", () => {
    const value = toReporting(money(1_000_000_000, "USDC"), "SGD", book);
    expect(value.state).toBe("converted");
    if (value.state !== "converted") return;
    expect(value.money).toEqual(money(135_000, "SGD"));
    expect(value.rates.map((rate) => rate.kind)).toEqual(["peg", "reference"]);
  });

  it("says unknown, with the reason, when a rate is missing, and never 1:1", () => {
    expect(toReporting(money(1_500_000, "KRW"), "SGD", book)).toEqual({
      state: "unknown",
      currency: "KRW",
      reason: "The last KRW rate recorded is from 2 Oct 2026, too old to report with.",
    });
    expect(toReporting(money(100, "MYR"), "USD", book)).toEqual({ state: "unknown", currency: "MYR", reason: "No MYR rate was recorded." });
    expect(toReporting(money(100, "MYR"), null, book)).toEqual({ state: "not_set" });
  });

  it("totals each currency, converts each total once, and a missing rate makes the total unknown with what is known apart", () => {
    const totals = reportingTotals(
      [money(100_000, "SGD"), money(150_000, "JPY"), money(2_000_000, "KRW"), money(500_000_000, "USDC"), money(35_000, "SGD")],
      "SGD",
      book
    );
    expect(totals.rows.map((row) => [formatMoney(row.total), row.count, row.value.state])).toEqual([
      ["150,000 JPY", 1, "converted"],
      ["2,000,000 KRW", 1, "unknown"],
      ["1,350.00 SGD", 2, "same"],
      ["500.00 USDC", 1, "converted"],
    ]);
    // 150,000 JPY = 1,000 USD = 1,350.00 SGD; 500 USDC = 675.00 SGD.
    expect(totals.total).toEqual({ state: "unknown", known: money(337_500, "SGD"), missing: ["KRW"] });
    expect(totals.rates.map((rate) => `${rate.from}>${rate.to}:${rate.kind}`)).toEqual(["USD>JPY:reference", "USD>SGD:reference", "USDC>USD:peg"]);
  });

  it("is known when every currency has its rate", () => {
    const totals = reportingTotals([money(100_000, "SGD"), money(15_000, "JPY")], "USD", book);
    expect(totals.total).toEqual({ state: "known", money: money(84_074, "USD") });
  });
});

describe("FX variance", () => {
  const paid = money(1_000_000_000, "USDC");

  it("is what the transfer carried less the bill's worth on the payment day, to the cent", () => {
    const variance = fxVariance({ paid, decision: usd("SGD", "1.35"), payment: usd("SGD", "1.36") });
    expect(variance && formatMoney(variance.covered)).toBe("1,350.00 SGD");
    expect(variance && formatMoney(variance.valueAtPayment)).toBe("992.65 USDC");
    expect(variance && formatMoney(variance.variance, { sign: true })).toBe("+7.35 USDC");
  });

  it("is negative when the bill's currency strengthened, and zero when the rate did not move", () => {
    expect(fxVariance({ paid, decision: usd("JPY", "150"), payment: usd("JPY", "148.5") })?.variance).toEqual(money(-10_100_000, "USDC"));
    expect(fxVariance({ paid, decision: usd("KRW", "1380.25"), payment: usd("KRW", "1380.25") })?.variance).toEqual(money(0, "USDC"));
  });

  it("keeps a discount out of the variance: the part paid is valued, not the whole bill", () => {
    // 2% off a 1,000 USDC bill: 980 USDC carried, covering 1,323.00 SGD of the bill.
    const variance = fxVariance({ paid: money(980_000_000, "USDC"), decision: usd("SGD", "1.35"), payment: usd("SGD", "1.35") });
    expect(variance?.covered).toEqual(money(132_300, "SGD"));
    expect(variance?.variance).toEqual(money(0, "USDC"));
  });

  it("is zero when the rate did not move, whatever micro-units the transfer carried, and values it at their precision", () => {
    const rate = usd("SGD", "1.35");
    // 2% off a 1,234.57 USDC bill: 1,209.8786 USDC carried. At the same rate it was worth exactly that.
    expect(fxVariance({ paid: money(1_209_878_600, "USDC"), decision: rate, payment: rate })?.variance).toEqual(money(0, "USDC"));
    expect(fxVariance({ paid: money(1, "USDC"), decision: rate, payment: rate })?.variance).toEqual(money(0, "USDC"));
    // At 1.36: 1,209.8786 x 1.35 / 1.36 = 1,200.98243…, to the ten-thousandth it was carried in.
    const moved = fxVariance({ paid: money(1_209_878_600, "USDC"), decision: rate, payment: usd("SGD", "1.36") });
    expect(moved?.valueAtPayment).toEqual(money(1_200_982_400, "USDC"));
    expect(moved?.variance).toEqual(money(8_896_200, "USDC"));
  });

  it("has none for a bill in dollars, a payment not in USDC or rates of two currencies", () => {
    expect(fxVariance({ paid, decision: usd("USD", "1"), payment: usd("USD", "1") })).toBeNull();
    expect(fxVariance({ paid: money(1, "EURC"), decision: usd("SGD", "1.35"), payment: usd("SGD", "1.36") })).toBeNull();
    expect(fxVariance({ paid, decision: usd("SGD", "1.35"), payment: usd("MYR", "4.4") })).toBeNull();
  });

  it("takes the newest rate published before the payment, within 36 hours, else none", () => {
    const rates = [usd("SGD", "1.34", "2026-10-11T00:02:00Z"), usd("SGD", "1.35", "2026-10-12T00:02:00Z"), usd("SGD", "1.36", "2026-10-13T00:02:00Z")];
    expect(rateAtPayment(rates, "2026-10-12T15:00:00Z")?.value).toBe("1.35");
    expect(rateAtPayment(rates, "2026-10-13T00:02:00Z")?.value).toBe("1.36");
    expect(rateAtPayment(rates, "2026-10-10T23:00:00Z")).toBeNull();
    expect(rateAtPayment(rates.slice(0, 1), "2026-10-12T13:00:00Z")).toBeNull();
  });
});

describe("provenance", () => {
  const figure = (overrides: Partial<MoneyFigure>): MoneyFigure => ({
    document: money(135_000, "SGD"),
    source: "Bill to pay",
    executable: money(1_000_000_000, "USDC"),
    conversion: [usd("SGD", "1.35"), pegRate("USDC")],
    reporting: { state: "same", money: money(135_000, "SGD") },
    ...overrides,
  });

  it("is full with the document, the conversion's source and time, a known reporting value and the payment's rate", () => {
    expect(fullProvenance(figure({}))).toBe(true);
    expect(fullProvenance(figure({ paymentRate: usd("SGD", "1.36") }))).toBe(true);
    expect(fullProvenance(figure({ reporting: { state: "not_set" } }))).toBe(true);
  });

  it("is partial without a conversion's time, with an unknown reporting value or an unknown rate at payment", () => {
    expect(fullProvenance(figure({ conversion: [{ ...usd("SGD", "1.35"), at: "" }] }))).toBe(false);
    expect(fullProvenance(figure({ conversion: [] }))).toBe(false);
    expect(fullProvenance(figure({ reporting: { state: "unknown", currency: "SGD", reason: "No SGD rate was recorded." } }))).toBe(false);
    expect(fullProvenance(figure({ paymentRate: null }))).toBe(false);
    expect(provenanceShare([figure({}), figure({ paymentRate: null })])).toEqual({ full: 1, total: 2 });
  });
});
