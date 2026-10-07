import { beforeEach, describe, expect, it, vi } from "vitest";
import { FxRateError, forgetUsdRates, usdRate } from "@/lib/fx/usd-rates";

/**
 * The day's rate for a bill's currency against the US dollar (docs/superpowers/specs/2026-10-07-shadow-mode-design.md
 * S6): from ExchangeRate-API's open endpoint, read at most once an hour, with when it was published. A dollar is a
 * USDC. A rate that cannot be read is said, never guessed.
 */

const PUBLISHED = 1_791_331_352; // Wed, 07 Oct 2026 00:02:32 UTC
const answer = (rates: Record<string, number>, over: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ result: "success", provider: "https://www.exchangerate-api.com", time_last_update_unix: PUBLISHED, base_code: "USD", rates, ...over }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  forgetUsdRates();
});

describe("usdRate", () => {
  it("reads how many of the currency make one US dollar, with its source and when it was published", async () => {
    const fetchFn = vi.fn(async () => answer({ USD: 1, VND: 25_935.897512, EUR: 0.888741 }));
    expect(await usdRate("vnd", { fetch: fetchFn as unknown as typeof fetch })).toEqual({
      currency: "VND",
      perUsd: 25_935.897512,
      source: "ExchangeRate-API",
      at: "2026-10-07T00:02:32.000Z",
    });
    expect(fetchFn).toHaveBeenCalledWith("https://open.er-api.com/v6/latest/USD", expect.objectContaining({ signal: expect.anything() }));
  });

  it("reads the rates once an hour, whatever currency is asked", async () => {
    let now = Date.parse("2026-10-07T10:00:00Z");
    const fetchFn = vi.fn(async () => answer({ USD: 1, VND: 25_935.897512, THB: 32.5 }));
    const deps = { fetch: fetchFn as unknown as typeof fetch, now: () => now };
    await usdRate("VND", deps);
    await usdRate("THB", deps);
    now += 59 * 60_000;
    await usdRate("VND", deps);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now += 2 * 60_000;
    await usdRate("VND", deps);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("takes a US dollar as one USDC, without asking", async () => {
    const fetchFn = vi.fn();
    expect(await usdRate("USD", { fetch: fetchFn as unknown as typeof fetch, now: () => Date.parse("2026-10-07T10:00:00Z") })).toEqual({
      currency: "USD",
      perUsd: 1,
      source: "USD = USDC",
      at: "2026-10-07T10:00:00.000Z",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("says when there is no rate for the currency", async () => {
    const fetchFn = vi.fn(async () => answer({ USD: 1, VND: 25_935.897512 }));
    await expect(usdRate("XYZ", { fetch: fetchFn as unknown as typeof fetch })).rejects.toThrow(new FxRateError("There is no rate for XYZ. Choose another currency."));
  });

  it("says the rate could not be read when the source fails or answers nonsense, and asks again next time", async () => {
    const failures = [
      vi.fn(async () => {
        throw new Error("network down");
      }),
      vi.fn(async () => new Response("busy", { status: 503 })),
      vi.fn(async () => answer({ VND: 25_935.9 }, { result: "error" })),
      vi.fn(async () => answer({ VND: -1 })),
    ];
    for (const fetchFn of failures) {
      forgetUsdRates();
      await expect(usdRate("VND", { fetch: fetchFn as unknown as typeof fetch })).rejects.toThrow(new FxRateError("The day's rate could not be read. Try again in a moment."));
    }
    const recovered = vi.fn(async () => answer({ VND: 25_935.897512 }));
    expect((await usdRate("VND", { fetch: recovered as unknown as typeof fetch })).perUsd).toBe(25_935.897512);
  });
});
