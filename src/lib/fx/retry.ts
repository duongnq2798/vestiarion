import { FxQuoteError } from "./errors";

/**
 * Asking Circle's Stablecoin Service again. Arc testnet's swap route comes and goes. On 2026-10-01 the same 1.9 EURC
 * was answered "No route available" and, a second later, quoted. On 2026-10-05 a quote failed twice and answered on the
 * third ask, after a 37 EURC payable had been held for want of a rate when two asks failed.
 *
 * So a no-route or failed answer is asked again, up to four times in all, waiting 0.75 s, then 1.5 s, then 3 s. Asking
 * stops once the next wait would pass a 15 s budget, so a service that hangs (each ask times out at 10 s) holds a cycle
 * for two asks, not four. An answer that cannot be read is not asked again, and neither is any other error.
 */

export const ROUTE_RETRY_DELAYS_MS = [750, 1_500, 3_000] as const;
export const ROUTE_BUDGET_MS = 15_000;

export async function askAgain<T>(
  work: () => Promise<T>,
  options: {
    /** One wait used between every ask instead of the growing ones: tests pass 0. */
    delayMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<T> {
  const delays = options.delayMs === undefined ? ROUTE_RETRY_DELAYS_MS : ROUTE_RETRY_DELAYS_MS.map(() => options.delayMs as number);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  for (let asked = 0; ; asked += 1) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof FxQuoteError) || error.code === "malformed") throw error;
      const wait = delays[asked];
      if (wait === undefined || now() - started + wait > ROUTE_BUDGET_MS) throw error;
      await sleep(wait);
    }
  }
}
