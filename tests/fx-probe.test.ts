import { afterEach, describe, expect, it, vi } from "vitest";
import { FxQuoteError } from "@/lib/fx/errors";
import { onceQuotes, probeFx } from "@/lib/fx/probe";
import { resetFxQuotesForTests } from "@/lib/fx/quote";
import type { FxHold } from "@/lib/fx/recheck";

/**
 * The fresh quote a held EURC payable is re-checked with (FX re-evaluation F2, F9): the rate for its amount, and, when
 * a swap held it, the swap that would cover what the wallet was short of. A probe never throws: no answer is no rate.
 */

const NOW = () => new Date("2026-10-05T02:00:00.000Z");
const rateQuote = (usdcEstimated: number, rate: number) => ({
  usdcEstimated,
  usdcMinimum: usdcEstimated * 0.97,
  rate,
  source: "circle-stablecoin-quote" as const,
  quotedAt: "2026-10-05T02:00:00.000Z",
});
const hold = (overrides: Partial<FxHold>): FxHold => ({
  blocker: "no_rate",
  decisionSeq: 1434,
  action: "hold",
  guardrailRule: null,
  amount: 0.5,
  rate: null,
  usdcValue: null,
  swapCostPercent: null,
  eurcShort: 0.5,
  ...overrides,
});

describe("probeFx", () => {
  it("asks the rate for the payable's amount, and no swap for a hold that was only the rate's", async () => {
    const quoteRate = vi.fn().mockResolvedValue(rateQuote(0.607631, 1.215262));
    const quoteSwap = vi.fn();
    expect(await probeFx(hold({}), { quoteRate, quoteSwap, now: NOW })).toEqual({
      rate: 1.215262,
      usdcValue: 0.607631,
      swapCostPercent: null,
      swapAvailable: null,
      quotedAt: "2026-10-05T02:00:00.000Z",
    });
    expect(quoteRate).toHaveBeenCalledWith(0.5);
    expect(quoteSwap).not.toHaveBeenCalled();
  });

  it("says there is no rate when Circle gives none, and asks for no swap", async () => {
    const quoteRate = vi.fn().mockRejectedValue(new FxQuoteError("no_route"));
    const quoteSwap = vi.fn();
    expect(await probeFx(hold({ blocker: "no_swap", rate: 1.2, usdcValue: 0.6 }), { quoteRate, quoteSwap, now: NOW })).toMatchObject({
      rate: null,
      usdcValue: null,
      swapAvailable: null,
    });
    expect(quoteSwap).not.toHaveBeenCalled();
  });

  it("sizes the swap for what the wallet was short of, at the fresh rate, for a hold that was the swap's", async () => {
    const quoteRate = vi.fn().mockResolvedValue(rateQuote(0.607631, 1.215262));
    // 0.5 EURC short at 1.215262 over the 3% slippage floor: 0.626424 USDC, which gives at least 0.505 EURC.
    const quoteSwap = vi.fn().mockResolvedValue({ eurcEstimated: 0.515, eurcMinimum: 0.505, provider: "lifi" });
    const now = await probeFx(hold({ blocker: "swap_cost", rate: 1.215262, usdcValue: 0.607631, swapCostPercent: 3.4 }), { quoteRate, quoteSwap, now: NOW });
    expect(quoteSwap).toHaveBeenCalledTimes(1);
    expect(quoteSwap.mock.calls[0][0]).toBeCloseTo(0.626424, 5);
    expect(now.swapAvailable).toBe(true);
    expect(now.swapCostPercent).toBeGreaterThan(0);
  });

  it("says no swap is available when Circle quotes none, or there is no way to ask, as in a sandbox", async () => {
    const quoteRate = vi.fn().mockResolvedValue(rateQuote(0.607631, 1.215262));
    const noRoute = vi.fn().mockRejectedValue(new FxQuoteError("no_route"));
    expect(await probeFx(hold({ blocker: "no_swap", rate: 1.2, usdcValue: 0.6 }), { quoteRate, quoteSwap: noRoute, now: NOW })).toMatchObject({
      rate: 1.215262,
      swapAvailable: false,
      swapCostPercent: null,
    });
    expect(await probeFx(hold({ blocker: "no_swap", rate: 1.2, usdcValue: 0.6 }), { quoteRate, now: NOW })).toMatchObject({ swapAvailable: false });
  });

  it("never throws: an unexpected failure is no answer", async () => {
    const quoteRate = vi.fn().mockRejectedValue(new Error("socket hang up"));
    await expect(probeFx(hold({}), { quoteRate, now: NOW })).resolves.toMatchObject({ rate: null, usdcValue: null });
  });
});

describe("onceQuotes: the quotes a re-check asks with (F9)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetFxQuotesForTests();
  });
  const noRoute = () => new Response(JSON.stringify({ code: 331001, message: "No route available" }), { status: 404 });

  it("asks Circle once for the rate, from the operating wallet's address", async () => {
    const fetch = vi.fn().mockImplementation(async () => noRoute());
    vi.stubGlobal("fetch", fetch);
    const quotes = onceQuotes({ operatingAddress: "0xbd4e5a44b211cc1171d925241a797df434139433", canSwap: true, apiKey: null });
    await expect(quotes.quoteRate(0.5)).rejects.toMatchObject({ code: "no_route" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain("fromAddress=0xbd4e5a44b211cc1171d925241a797df434139433");
  });

  it("asks once for a swap where one can be made, and offers no swap quote where none can", async () => {
    const fetch = vi.fn().mockImplementation(async () => noRoute());
    vi.stubGlobal("fetch", fetch);
    const live = onceQuotes({ operatingAddress: "0xbd4e5a44b211cc1171d925241a797df434139433", canSwap: true, apiKey: null });
    await expect(live.quoteSwap?.(0.63)).rejects.toMatchObject({ code: "no_route" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onceQuotes({ operatingAddress: "0xbd4e5a44b211cc1171d925241a797df434139433", canSwap: false, apiKey: null }).quoteSwap).toBeUndefined();
    expect(onceQuotes({ operatingAddress: null, canSwap: true, apiKey: null }).quoteSwap).toBeUndefined();
  });
});

