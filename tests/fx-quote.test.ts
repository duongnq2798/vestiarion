import { beforeEach, describe, expect, it, vi } from "vitest";
import { ARC_TESTNET_EURC, ARC_TESTNET_USDC, FxQuoteError, quoteEurcInUsdc, resetFxQuotesForTests } from "@/lib/fx/quote";

/**
 * The EURC→USDC rate (EURC invoices spec E2): a quote from Circle's
 * Stablecoin Service for the amount, on Arc testnet, with a deadline and a
 * 5-minute cache. The network is faked; the answer's shape is the service's own
 * (captured 2026-10-01: 10 EURC → 12.161872 USDC via LiFi).
 */

const FROM = "0x2fafdda3f973e8f993911f1c2196d5e72d51d71d";
const NOW = Date.parse("2026-10-01T00:00:00Z");

const answer = (estimated: string, minimum: string) =>
  new Response(
    JSON.stringify({
      quote: { estimatedAmount: estimated, minAmount: minimum, route: { provider: "lifi", steps: [] } },
      fees: [],
      feeContext: { type: "input" },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

beforeEach(() => resetFxQuotesForTests());

describe("quoteEurcInUsdc", () => {
  it("asks for EURC→USDC on Arc testnet in base units, and reads the amounts exactly", async () => {
    const fetch = vi.fn().mockResolvedValue(answer("12161872", "11797015"));
    const quote = await quoteEurcInUsdc(10, { fromAddress: FROM, now: NOW, fetch });

    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.circle.com/v1/stablecoinKits/quote");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tokenInAddress: ARC_TESTNET_EURC,
      tokenInChain: "Arc_Testnet",
      tokenOutAddress: ARC_TESTNET_USDC,
      tokenOutChain: "Arc_Testnet",
      fromAddress: FROM,
      toAddress: FROM,
      amount: "10000000",
      slippageBps: "300",
    });
    expect(quote).toEqual({
      usdcEstimated: 12.161872,
      usdcMinimum: 11.797015,
      rate: 1.216187,
      source: "circle-stablecoin-quote",
      quotedAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("turns amounts into base units without float drift", async () => {
    const fetch = vi.fn().mockResolvedValue(answer("1", "1"));
    await quoteEurcInUsdc(0.1 + 0.2, { fromAddress: FROM, now: NOW, fetch });
    expect(new URL(fetch.mock.calls[0][0] as string).searchParams.get("amount")).toBe("300000");
  });

  it("answers the same amount from memory for 5 minutes, then asks again", async () => {
    const fetch = vi.fn().mockImplementation(async () => answer("12161872", "11797015"));
    await quoteEurcInUsdc(10, { fromAddress: FROM, now: NOW, fetch });
    await quoteEurcInUsdc(10, { fromAddress: FROM, now: NOW + 5 * 60_000, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    await quoteEurcInUsdc(10, { fromAddress: FROM, now: NOW + 5 * 60_000 + 1, fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("says there is no route when the service has none", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 331001, message: "No route available" }), { status: 400 }));
    await expect(quoteEurcInUsdc(10, { fromAddress: FROM, now: NOW, fetch })).rejects.toMatchObject({ code: "no_route" });
  });

  it("says it is unavailable when the service fails or does not answer in time", async () => {
    const down = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(quoteEurcInUsdc(10, { fromAddress: FROM, now: NOW, fetch: down })).rejects.toMatchObject({ code: "unavailable" });
    const slow = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    });
    await expect(quoteEurcInUsdc(11, { fromAddress: FROM, now: NOW, fetch: slow })).rejects.toBeInstanceOf(FxQuoteError);
  });

  it("refuses an answer of the wrong shape, or with no USDC out", async () => {
    const malformed = vi.fn().mockResolvedValue(new Response(JSON.stringify({ quote: {} }), { status: 200 }));
    await expect(quoteEurcInUsdc(10, { fromAddress: FROM, now: NOW, fetch: malformed })).rejects.toMatchObject({ code: "malformed" });
    const zero = vi.fn().mockResolvedValue(answer("0", "0"));
    await expect(quoteEurcInUsdc(12, { fromAddress: FROM, now: NOW, fetch: zero })).rejects.toMatchObject({ code: "malformed" });
  });

  it("refuses to quote nothing or a negative amount, asking nothing", async () => {
    const fetch = vi.fn();
    for (const amount of [0, -1, Number.NaN]) {
      await expect(quoteEurcInUsdc(amount, { fromAddress: FROM, now: NOW, fetch })).rejects.toBeInstanceOf(RangeError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the rate's precision (review M3)", () => {
  it("is kept to six decimals, as amounts are", async () => {
    resetFxQuotesForTests();
    const fetch = async () =>
      new Response(JSON.stringify({ quote: { estimatedAmount: "3647451", minAmount: "3538027" } }), { status: 200, headers: { "content-type": "application/json" } });
    const quote = await quoteEurcInUsdc(3, { fromAddress: "0x0000000000000000000000000000000000000001", fetch: fetch as unknown as typeof globalThis.fetch });
    expect(quote.rate).toBe(1.215817);
  });
});
