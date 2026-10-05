import { describe, expect, it, vi } from "vitest";
import { FxQuoteError } from "@/lib/fx/quote";
import { askAgain, ROUTE_RETRY_DELAYS_MS } from "@/lib/fx/retry";

/**
 * Arc testnet's swap route comes and goes. On 2026-10-05 the same EURC→USDC quote answered "No route available" twice,
 * then quoted on the third ask, and a 37 EURC payable was held for want of a rate after the two asks it got. A
 * no-route or failed answer is asked again, up to four times in all, waiting a little longer each time, within a time
 * budget; an answer that cannot be read is not asked again.
 */

const noRoute = () => new FxQuoteError("no_route");

function clock(stepMs: number) {
  let now = 0;
  return {
    now: () => now,
    sleep: vi.fn(async (ms: number) => {
      now += ms;
    }),
    // Each ask takes `stepMs`, as a request that times out does.
    ask: <T,>(answer: () => T) => async () => {
      now += stepMs;
      return answer();
    },
  };
}

describe("askAgain", () => {
  it("asks up to four times, waiting 0.75 s, 1.5 s and 3 s between, and answers as soon as one works", async () => {
    const time = clock(200);
    let asked = 0;
    const work = time.ask(() => {
      asked += 1;
      if (asked < 4) throw noRoute();
      return "quoted";
    });
    await expect(askAgain(work, { now: time.now, sleep: time.sleep })).resolves.toBe("quoted");
    expect(asked).toBe(4);
    expect(time.sleep.mock.calls.map(([ms]) => ms)).toEqual([...ROUTE_RETRY_DELAYS_MS]);
  });

  it("gives the last refusal after four asks", async () => {
    const time = clock(200);
    const work = vi.fn(time.ask(() => {
      throw noRoute();
    }));
    await expect(askAgain(work, { now: time.now, sleep: time.sleep })).rejects.toMatchObject({ code: "no_route" });
    expect(work).toHaveBeenCalledTimes(4);
  });

  it("stops asking once the next wait would pass the time budget, so a service that hangs does not hold the cycle", async () => {
    // Each ask times out after 10 s: the second starts at 10.75 s, and a third would start after 22.25 s.
    const time = clock(10_000);
    const work = vi.fn(time.ask(() => {
      throw new FxQuoteError("unavailable");
    }));
    await expect(askAgain(work, { now: time.now, sleep: time.sleep })).rejects.toMatchObject({ code: "unavailable" });
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("never asks again for an answer that cannot be read, or for anything that is not a quote error", async () => {
    const time = clock(0);
    const malformed = vi.fn(time.ask(() => {
      throw new FxQuoteError("malformed");
    }));
    await expect(askAgain(malformed, { now: time.now, sleep: time.sleep })).rejects.toMatchObject({ code: "malformed" });
    expect(malformed).toHaveBeenCalledTimes(1);
    const broken = vi.fn(time.ask(() => {
      throw new RangeError("bug");
    }));
    await expect(askAgain(broken, { now: time.now, sleep: time.sleep })).rejects.toBeInstanceOf(RangeError);
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it("asks once and gives its refusal when told to, as a re-check of a held payable does (FX re-evaluation F9)", async () => {
    const time = clock(0);
    const work = vi.fn(time.ask(() => {
      throw noRoute();
    }));
    await expect(askAgain(work, { once: true, now: time.now, sleep: time.sleep })).rejects.toMatchObject({ code: "no_route" });
    expect(work).toHaveBeenCalledTimes(1);
    expect(time.sleep).not.toHaveBeenCalled();
  });

  it("waits the one delay given instead, as tests ask for none", async () => {
    const time = clock(0);
    const work = vi.fn(time.ask(() => {
      throw noRoute();
    }));
    await expect(askAgain(work, { delayMs: 0, now: time.now, sleep: time.sleep })).rejects.toMatchObject({ code: "no_route" });
    expect(time.sleep.mock.calls.map(([ms]) => ms)).toEqual([0, 0, 0]);
  });
});
