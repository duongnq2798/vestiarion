import type { EurcQuote } from "./quote";
import type { FxHold, FxNow } from "./recheck";
import { sizeSwap, type SwapQuote } from "./swap-service";

/**
 * The fresh quote a EURC payable held for FX is re-checked with (FX re-evaluation F2, F9): the rate for its amount, and,
 * when a swap held it, the swap that would cover what the wallet was short of, sized as the AP stage sizes it. Each
 * quote is asked once by the caller's functions. A probe never throws: a failure is no answer, and the payable stays
 * held until the next re-check.
 */
export async function probeFx(
  hold: FxHold,
  deps: {
    quoteRate: (amountEurc: number) => Promise<EurcQuote>;
    /** Absent where no swap can be made, as in a sandbox. */
    quoteSwap?: (usdcIn: number) => Promise<SwapQuote>;
    now?: () => Date;
  }
): Promise<FxNow> {
  const quotedAt = (deps.now ?? (() => new Date()))().toISOString();
  let quote: EurcQuote | null = null;
  try {
    quote = await deps.quoteRate(hold.amount);
  } catch (error) {
    console.info("fx re-check: no EURC rate", error instanceof Error ? error.message : error);
  }
  const answer: FxNow = { rate: quote?.rate ?? null, usdcValue: quote?.usdcEstimated ?? null, swapCostPercent: null, swapAvailable: null, quotedAt };
  if (quote === null || (hold.blocker !== "no_swap" && hold.blocker !== "swap_cost")) return answer;

  if (!deps.quoteSwap || hold.eurcShort === null || hold.eurcShort <= 0) return { ...answer, swapAvailable: false };
  try {
    const sized = await sizeSwap(hold.eurcShort, quote.rate, deps.quoteSwap);
    return { ...answer, swapAvailable: sized.offer !== null, swapCostPercent: sized.offer?.costPercent ?? null };
  } catch (error) {
    console.info("fx re-check: no USDC→EURC swap", error instanceof Error ? error.message : error);
    return { ...answer, swapAvailable: false };
  }
}
