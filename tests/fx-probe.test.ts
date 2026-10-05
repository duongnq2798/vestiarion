import { describe, expect, it, vi } from "vitest";
import { FxQuoteError } from "@/lib/fx/errors";
import { probeFx } from "@/lib/fx/probe";
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
