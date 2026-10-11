import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { FxRateError } from "@/lib/fx/usd-rates";
import { billAmount, shadowBill, ShadowBillError, usdcFor } from "@/lib/shadow-bills";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * A bill in the business's own currency, in shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S6):
 * its amount read as it is written on the bill, and the USDC it is paid in at the day's rate, with the rate kept.
 */

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000001a1a";
const VND = { currency: "VND", perUsd: 25_935.897512, source: "ExchangeRate-API", at: "2026-10-07T00:02:32.000Z" };

const inWorkspace = <T,>(shadow: boolean, fn: () => Promise<T>) => {
  const fake = fakeSupabase((r) => (r.path === "/rest/v1/shadow_modes" ? { body: shadow ? [{ currency: "VND", started_at: "2026-10-07T00:00:00Z", started_by: null }] : [] } : { body: [] }));
  return runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: "u1" }), fn);
};

describe("billAmount", () => {
  it.each([
    ["2.500.000", "VND", 2_500_000],
    ["2,500,000", "VND", 2_500_000],
    ["2 500 000", "VND", 2_500_000],
    ["2500000", "VND", 2_500_000],
    ["1,234.56", "USD", 1234.56],
    ["1.234,56", "EUR", 1234.56],
    ["1 234,56", "EUR", 1234.56],
    ["99,5", "EUR", 99.5],
    ["1234", "THB", 1234],
  ])("reads %s %s as written on the bill", (typed, currency, amount) => {
    expect(billAmount(typed, currency)).toBe(amount);
  });

  it.each([
    ["2.500.000,50", "VND"],
    ["25.00.000", "VND"],
    ["0", "VND"],
    ["-5", "USD"],
    ["1,2345", "USD"],
    ["12.34.56", "USD"],
    ["abc", "USD"],
    ["", "VND"],
  ])("refuses %s %s, which is no amount on a bill", (typed, currency) => {
    expect(billAmount(typed, currency)).toBeNull();
  });
});

describe("usdcFor", () => {
  it("converts at the rate, to the cent", () => {
    expect(usdcFor(2_500_000, 25_935.897512)).toBe(96.39);
    expect(usdcFor(1234.56, 1)).toBe(1234.56);
  });

  it("is nothing for an amount worth less than a cent", () => {
    expect(usdcFor(100, 25_935.897512)).toBeNull();
  });
});

describe("shadowBill", () => {
  it("takes a bill in the business's currency at the day's rate, and keeps the rate", async () => {
    const rate = vi.fn(async () => VND);
    expect(await inWorkspace(true, () => shadowBill({ currency: "vnd", amount: "2.500.000" }, { rate }))).toEqual({
      usdc: 96.39,
      original: { currency: "VND", amount: 2_500_000, perUsd: 25_935.897512, source: "ExchangeRate-API", at: "2026-10-07T00:02:32.000Z" },
    });
    expect(rate).toHaveBeenCalledWith("VND");
  });

  it("is only for a workspace in shadow mode", async () => {
    await expect(inWorkspace(false, () => shadowBill({ currency: "VND", amount: "2.500.000" }, { rate: async () => VND }))).rejects.toMatchObject({
      code: "not_in_shadow",
      message: "A bill in another currency is taken in shadow mode only. Vestiarion pays in USDC or EURC.",
    });
  });

  it("refuses a currency that is not one, an amount that is not one, and one worth less than a cent", async () => {
    const rate = async () => VND;
    await expect(inWorkspace(true, () => shadowBill({ currency: "USDC", amount: "10" }, { rate }))).rejects.toMatchObject({ code: "invalid_currency" });
    await expect(inWorkspace(true, () => shadowBill({ currency: "VND", amount: "two million" }, { rate }))).rejects.toMatchObject({ code: "amount" });
    await expect(inWorkspace(true, () => shadowBill({ currency: "VND", amount: "100" }, { rate }))).rejects.toMatchObject({ code: "too_small" });
  });

  it("says when the day's rate could not be read", async () => {
    const rate = async () => {
      throw new FxRateError("The day's rate could not be read. Try again in a moment.");
    };
    await expect(inWorkspace(true, () => shadowBill({ currency: "VND", amount: "2.500.000" }, { rate }))).rejects.toThrow("The day's rate could not be read. Try again in a moment.");
  });

  it("takes the shadow mode it is told, reading no row, for an import of many bills (import design B15)", async () => {
    const fake = fakeSupabase(() => ({ body: [] }));
    const scope = () => orgTestContext({ config, client: fake.client, orgId: ORG, userId: "u1" });
    const bill = await runWith(scope(), () => shadowBill({ currency: "VND", amount: "2500000" }, { rate: async () => VND, shadowOn: true }));
    expect(bill.usdc).toBe(96.39);
    await expect(runWith(scope(), () => shadowBill({ currency: "VND", amount: "2500000" }, { rate: async () => VND, shadowOn: false }))).rejects.toMatchObject({
      code: "not_in_shadow",
    });
    expect(fake.requests).toEqual([]);
  });

  it("says each refusal in words a person reads", () => {
    expect(new ShadowBillError("amount").message).toBe("Type the bill's amount as it is written on it, such as 1,250.00.");
    expect(new ShadowBillError("invalid_currency").message).toBe("Choose the bill's currency as a three-letter code, such as EUR.");
  });
});
