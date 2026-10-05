import { quoteEurcInUsdc, type EurcQuote } from "./quote";
import type { NetworkProfile } from "../network";
import type { FxHold, FxNow } from "./recheck";
import { quoteUsdcForEurc, sizeSwap, type SwapQuote } from "./swap-service";

/**
 * The quotes a re-check asks with, each asked once (F9): the rate from the operating wallet's address, as the AP stage
 * asks it, and a swap only where one can be made (a live workspace with an operating wallet that can swap).
 */
export function onceQuotes(input: { network: NetworkProfile; operatingAddress: string | null; canSwap: boolean; apiKey: string | null }): {
  quoteRate: (amountEurc: number) => Promise<EurcQuote>;
  quoteSwap?: (usdcIn: number) => Promise<SwapQuote>;
} {
  const address = input.operatingAddress;
  return {
    quoteRate: (amountEurc) => quoteEurcInUsdc(amountEurc, { network: input.network, fromAddress: address ?? input.network.tokens.EURC, once: true }),
    ...(input.canSwap && address ? { quoteSwap: (usdcIn: number) => quoteUsdcForEurc(usdcIn, { network: input.network, fromAddress: address, apiKey: input.apiKey, once: true }) } : {}),
  };
}

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
