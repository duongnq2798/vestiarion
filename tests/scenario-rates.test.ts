import { describe, expect, it } from "vitest";
import { cashOutlook } from "@/lib/cash-outlook";
import { scenarioBasis } from "@/lib/cash-scenario-basis";
import { cashScenario, type BasisOutflow, type ScenarioBasis, type ScenarioLevers } from "@/lib/cash-scenarios";
import { readScenarioInput, ScenarioVersionError } from "@/lib/scenario-versions";

/**
 * Exchange rates in a cash scenario (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M7): a rate typed
 * for a currency values that currency's open bills at it, from each bill's own amount, to the cent and exactly; empty
 * keeps each at its own conversion, so the base case and Safe to spend today never move. A saved version's input is
 * checked before it is kept.
 */

const NOW = Date.parse("2026-10-13T09:00:00Z");
const at = (offset: number) => new Date(Date.UTC(2026, 9, 13 + offset, 12)).toISOString();

const basis = (outflows: BasisOutflow[], over: Partial<ScenarioBasis> = {}): ScenarioBasis => ({
  today: "2026-10-13",
  cash: 5000,
  reserve: 0,
  outflows,
  receivables: [],
  clients: {},
  eurc: [],
  recurringRead: true,
  ...over,
});
const sgdBill = (label: string, sgd: string, usdc: number, day: number): BasisOutflow => ({
  id: `bill-${label}`,
  kind: "bill",
  label,
  amount: usdc,
  day,
  note: "due",
  foreign: true,
  original: { currency: "SGD", amount: sgd, perUsd: "1.35" },
});
const levers = (over: Partial<ScenarioLevers> = {}): ScenarioLevers => ({ horizon: 30, lateDays: 0, choices: {}, costPct: 0, costScope: "all", ...over });

describe("the rate lever", () => {
  const bills = [sgdBill("Harbor", "1350.00", 1000, 2), sgdBill("Atlas", "675.00", 500, 9), { id: "usdc", kind: "bill" as const, label: "Linh", amount: 300, day: 4, note: "due" as const, foreign: false }];

  it("changes nothing while no rate is typed", () => {
    const result = cashScenario(basis(bills), levers());
    expect(result.rateDelta).toBe(0);
    expect(result.rateEffects).toEqual([]);
    expect(result.outflows.scenario).toBe(result.outflows.base);
    expect(result.levers.rates).toEqual({});
  });

  it("values each SGD bill at the typed rate from its own amount, to the cent, and leaves other bills alone", () => {
    const result = cashScenario(basis(bills), levers({ rates: { SGD: "1.40" } }));
    // 1,350.00 / 1.40 = 964.285… → 964.29; 675.00 / 1.40 = 482.142… → 482.14.
    expect(result.rateEffects).toEqual([{ currency: "SGD", perUsd: "1.4", bills: 2, converted: 1500, atRate: 1446.43 }]);
    expect(result.rateDelta).toBe(-53.57);
    expect(result.outflows.scenario).toBe(1746.43);
    expect(result.outflows.base).toBe(1800);
    expect(result.levers.rates).toEqual({ SGD: "1.4" });
  });

  it("applies the cost lever after the rate, and names each apart", () => {
    const result = cashScenario(basis(bills), levers({ rates: { SGD: "1.30" }, costPct: 10, costScope: "foreign" }));
    // 1,350 / 1.30 = 1,038.46; 675 / 1.30 = 519.23: 57.69 more at the rate; then 10% on the foreign bills, on top.
    expect(result.rateDelta).toBe(57.69);
    expect(result.costDelta).toBe(155.769);
  });

  it("names a rate that moves the balance most among what moves it", () => {
    // At 0.5 SGD to the dollar, the 1,350.00 SGD bill comes to 2,700.00 USDC: 1,700.00 more than as converted.
    const result = cashScenario(basis([sgdBill("Harbor", "1350.00", 1000, 2)]), levers({ rates: { SGD: "0.5" } }));
    expect(result.drivers[0]).toEqual({ kind: "rates", amount: 1700, currencies: ["SGD"] });
  });

  it("ignores a rate that does not read, or one for a currency no bill is in", () => {
    const tries: Array<Record<string, string>> = [{ SGD: "" }, { SGD: "abc" }, { SGD: "0" }, { SGD: "-1.3" }, { MYR: "4.4" }, { USD: "2" }];
    for (const rates of tries) {
      const result = cashScenario(basis(bills), levers({ rates }));
      expect(result.rateDelta, JSON.stringify(rates)).toBe(0);
      expect(result.outflows.scenario).toBe(1800);
    }
  });

  it("is exact for yen and won, with no decimals", () => {
    const yen: BasisOutflow = { ...sgdBill("Tokyo", "150000", 1005.15, 3), original: { currency: "JPY", amount: "150000", perUsd: "149.235" } };
    const won: BasisOutflow = { ...sgdBill("Seoul", "1380250", 1000, 3), id: "won", original: { currency: "KRW", amount: "1380250", perUsd: "1380.25" } };
    const result = cashScenario(basis([yen, won]), levers({ rates: { JPY: "150", KRW: "1400" } }));
    expect(result.rateEffects).toEqual([
      { currency: "JPY", perUsd: "150", bills: 1, converted: 1005.15, atRate: 1000 },
      { currency: "KRW", perUsd: "1400", bills: 1, converted: 1000, atRate: 985.89 },
    ]);
  });

  it("is carried from the rows: a converted bill's own amount and rate reach the basis, and Next 30 days does not move", () => {
    const input = {
      now: NOW,
      operatingUsdc: 2000,
      reserveUsdc: 0,
      payables: [
        { id: "a", counterparty: "Harbor", amount: 1000, currency: "USDC", due_date: at(2), status: "pending", scheduled_for: null, original_currency: "SGD", original_amount: 1350, fx_rate: 1.35 },
        { id: "b", counterparty: "Linh", amount: 300, currency: "USDC", due_date: at(4), status: "pending", scheduled_for: null },
      ],
      milestones: [],
      receivables: [],
    };
    const outlook = cashOutlook(input);
    expect(outlook.dueIn30d).toBe(1300);
    const start = scenarioBasis({ ...input, recurring: [] });
    expect(start.outflows.find((outflow) => outflow.id === "a")?.original).toEqual({ currency: "SGD", amount: "1350", perUsd: "1.35" });
    expect(start.outflows.find((outflow) => outflow.id === "b")?.original).toBeUndefined();
    expect(cashScenario(start, levers({ rates: { SGD: "1.5" } })).rateEffects[0]).toMatchObject({ converted: 1000, atRate: 900 });
  });
});

describe("a saved version's input", () => {
  const LEVERS = { horizon: 60, lateDays: 14, costPct: 0, costScope: "all", choices: {} };

  it("keeps a name, the levers within their ranges and each rate as typed, once per currency", () => {
    const read = readScenarioInput({
      name: "  SGD weakens ",
      levers: LEVERS,
      rates: [{ currency: "SGD", perUsd: "1.4000", reference: { perUsd: "1.3512", source: "ExchangeRate-API", at: "2026-10-13T00:02:31.000Z" } }],
    });
    expect(read).toEqual({
      name: "SGD weakens",
      levers: LEVERS,
      rates: [{ currency: "SGD", perUsd: "1.4", reference: { perUsd: "1.3512", source: "ExchangeRate-API", at: "2026-10-13T00:02:31.000Z" } }],
    });
  });

  it.each([
    ["an empty name", { name: " ", levers: LEVERS, rates: [] }, "name"],
    ["a horizon of 45 days", { name: "n", levers: { ...LEVERS, horizon: 45 }, rates: [] }, "levers"],
    ["a cost change past 100%", { name: "n", levers: { ...LEVERS, costPct: 150 }, rates: [] }, "levers"],
    ["a lever it does not know", { name: "n", levers: { ...LEVERS, extra: 1 }, rates: [] }, "levers"],
    ["a rate of zero", { name: "n", levers: LEVERS, rates: [{ currency: "SGD", perUsd: "0", reference: null }] }, "rates"],
    ["a currency twice", { name: "n", levers: LEVERS, rates: [{ currency: "SGD", perUsd: "1.4", reference: null }, { currency: "SGD", perUsd: "1.5", reference: null }] }, "rates"],
    ["a rate for the dollar", { name: "n", levers: LEVERS, rates: [{ currency: "USD", perUsd: "1", reference: null }] }, "rates"],
  ])("refuses %s", (_label, input, code) => {
    expect(() => readScenarioInput(input as never)).toThrow(ScenarioVersionError);
    try {
      readScenarioInput(input as never);
    } catch (error) {
      expect((error as ScenarioVersionError).code).toBe(code);
    }
  });
});
