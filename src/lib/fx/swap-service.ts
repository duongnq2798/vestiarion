import { ArcTestnet } from "@circle-fin/app-kit/chains";
import { encodeFunctionData, type Hex } from "viem";
import { z } from "zod";
import { ARC_TESTNET_EURC, ARC_TESTNET_USDC, FxQuoteError, fromBaseUnits, toBaseUnits } from "./quote";
import { askAgain } from "./retry";
import { SWAP_SLIPPAGE_BPS } from "./swap-limits";

export { SWAP_COST_CAP_PERCENT, SWAP_SLIPPAGE_BPS } from "./swap-limits";

/**
 * A swap of USDC for EURC on Arc testnet through Circle's Stablecoin Service, the service App Kit's
 * `kit.swap()` calls (docs/superpowers/specs/2026-10-01-eurc-swap-design.md S1, S6, R1). This module
 * only asks: what a swap would give, and the transaction for one. Sending it is the provider's, under
 * the swap's own keys (src/lib/fx/swap.ts).
 *
 * The transaction is sent as App Kit's adapters send it: `execute(params, tokenInputs, signature)` to
 * the Adapter contract App Kit's chain definition names for Arc testnet, after an ordinary approval
 * of the Adapter for the USDC (App Kit's `approve` allowance strategy, PermitType.NONE).
 */

const QUOTE_URL = "https://api.circle.com/v1/stablecoinKits/quote";
const SWAP_URL = "https://api.circle.com/v1/stablecoinKits/swap";
const DEADLINE_MS = 10_000;
const NO_ROUTE = 331001;

/** The Adapter contract on Arc testnet, from App Kit's own chain definition. */
export const ADAPTER: string = ArcTestnet.kitContracts.adapter;

/** App Kit's Adapter `execute`, as its EVM adapters encode it (selector 0xaa3e079c). */
export const ADAPTER_EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    outputs: [],
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "instructions",
            type: "tuple[]",
            components: [
              { name: "target", type: "address" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
              { name: "tokenIn", type: "address" },
              { name: "amountToApprove", type: "uint256" },
              { name: "tokenOut", type: "address" },
              { name: "minTokenOut", type: "uint256" },
            ],
          },
          {
            name: "tokens",
            type: "tuple[]",
            components: [
              { name: "token", type: "address" },
              { name: "beneficiary", type: "address" },
            ],
          },
          { name: "execId", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "metadata", type: "bytes" },
        ],
      },
      {
        name: "tokenInputs",
        type: "tuple[]",
        components: [
          { name: "permitType", type: "uint8" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "permitCalldata", type: "bytes" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

/** What a swap of some USDC would give, from a quote. */
export interface SwapQuote {
  eurcEstimated: number;
  eurcMinimum: number;
  provider: string | null;
}

/** A swap the agent is offered for a payable whose EURC is short (S1). */
export interface SwapOffer {
  usdcIn: number;
  eurcEstimated: number;
  eurcMinimum: number;
  /** USDC per EURC: the rate the payable was weighed at. */
  usdcPerEurc: number;
  /** What each EURC costs through the swap, above `usdcPerEurc`, in percent. */
  costPercent: number;
  provider: string | null;
}

export type SwapSizing = { offer: SwapOffer } | { offer: null; reason: string };

/** A swap's transaction, ready to send to the Adapter. */
export interface SwapTransaction {
  eurcEstimated: number;
  eurcMinimum: number;
  provider: string | null;
  adapter: string;
  callData: Hex;
  /** After this the Adapter refuses the swap: its signature is for this long. */
  deadline: Date;
}

interface AskOptions {
  fromAddress: string;
  /** The workspace's Circle API key, sent as a bearer token: the service rate-limits requests without one. */
  apiKey?: string | null;
  fetch?: typeof fetch;
  retryDelayMs?: number;
  /** Ask once, as a re-check of a held payable does (FX re-evaluation F9). */
  once?: boolean;
}

const micro = (amount: number) => Math.ceil(Number((amount * 1_000_000).toFixed(3))) / 1_000_000;

/**
 * What each EURC costs through a swap above the rate the payable was weighed at, in percent, rounded up
 * to two places: a cost just above the cap is never shown at it (review #4).
 */
export function swapCostPercent(usdcIn: number, eurcEstimated: number, usdcPerEurc: number): number {
  return Math.ceil(Number(((usdcIn / eurcEstimated / usdcPerEurc - 1) * 10_000).toFixed(6))) / 100;
}

/** One request, with the key when there is one, and without it once if the service refuses the key. */
async function ask(url: string, init: RequestInit, options: AskOptions): Promise<unknown> {
  const send = async (withKey: boolean) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (withKey && options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    try {
      return await (options.fetch ?? fetch)(url, { ...init, headers, signal: AbortSignal.timeout(DEADLINE_MS), cache: "no-store" });
    } catch {
      throw new FxQuoteError("unavailable");
    }
  };
  let response = await send(true);
  if (options.apiKey && (response.status === 401 || response.status === 403)) response = await send(false);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new FxQuoteError("malformed");
  }
  if (!response.ok) throw new FxQuoteError((body as { code?: unknown } | null)?.code === NO_ROUTE ? "no_route" : "unavailable");
  return body;
}

/** Arc testnet's route comes and goes (src/lib/fx/retry.ts): a missing route or a failed request is asked again. */
function once<T>(work: () => Promise<T>, retryDelayMs: number | undefined, askOnce?: boolean): Promise<T> {
  return askAgain(work, { delayMs: retryDelayMs, once: askOnce });
}

const baseUnits = z.string().regex(/^\d+$/);
const quoteSchema = z.object({
  quote: z.object({ estimatedAmount: baseUnits, minAmount: baseUnits, route: z.object({ provider: z.string().optional() }).passthrough().optional() }),
});

/** What swapping `usdcIn` USDC for EURC on Arc testnet would give now. Throws `FxQuoteError`. */
export async function quoteUsdcForEurc(usdcIn: number, options: AskOptions): Promise<SwapQuote> {
  if (!Number.isFinite(usdcIn) || usdcIn <= 0) throw new RangeError("A USDC amount to swap must be positive");
  const url = new URL(QUOTE_URL);
  url.search = new URLSearchParams({
    tokenInAddress: ARC_TESTNET_USDC,
    tokenInChain: "Arc_Testnet",
    tokenOutAddress: ARC_TESTNET_EURC,
    tokenOutChain: "Arc_Testnet",
    fromAddress: options.fromAddress,
    toAddress: options.fromAddress,
    amount: toBaseUnits(usdcIn),
    slippageBps: String(SWAP_SLIPPAGE_BPS),
  }).toString();
  return once(async () => {
    const parsed = quoteSchema.safeParse(await ask(url.toString(), { method: "GET" }, options));
    // A zero estimate or minimum is no quote: sizing divides by the minimum (review #2).
    if (!parsed.success || BigInt(parsed.data.quote.estimatedAmount) === BigInt(0) || BigInt(parsed.data.quote.minAmount) === BigInt(0)) {
      throw new FxQuoteError("malformed");
    }
    return {
      eurcEstimated: fromBaseUnits(parsed.data.quote.estimatedAmount),
      eurcMinimum: fromBaseUnits(parsed.data.quote.minAmount),
      provider: parsed.data.quote.route?.provider ?? null,
    };
  }, options.retryDelayMs, options.once);
}

/** Why no swap could be offered because of Circle's answer, as a decision records it (`swapUnavailable`). */
export const NO_SWAP_ROUTE = "No USDC→EURC route on Arc testnet right now.";
export const SWAP_QUOTE_UNREADABLE = "The USDC→EURC quote could not be read.";
export const SWAP_QUOTE_UNANSWERED = "Circle's Stablecoin Service did not answer for a USDC→EURC quote.";
export const SWAP_NOT_QUOTED = "The USDC→EURC swap could not be quoted.";
const SWAP_MINIMUM_SHORT = "The swap's minimum,";

/**
 * Whether a decision's `swapUnavailable` says Circle gave no usable swap — no route, no answer, an unreadable quote, or
 * a minimum short of what was needed — which a later quote can change (FX re-evaluation F1). A swap refused because the
 * payment had already started is not one.
 */
export function swapUnavailableForFx(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return [NO_SWAP_ROUTE, SWAP_QUOTE_UNREADABLE, SWAP_QUOTE_UNANSWERED, SWAP_NOT_QUOTED].includes(reason) || reason.startsWith(SWAP_MINIMUM_SHORT);
}

/**
 * The swap to offer for a payable `short` EURC short (S1): enough USDC that the swap's minimum covers
 * it. A first guess from the rate the payable was weighed at, over the slippage floor; scaled once by
 * what its minimum missed. Null, with the reason, when there is no route or the minimum still falls short.
 */
export async function sizeSwap(short: number, usdcPerEurc: number, quote: (usdcIn: number) => Promise<SwapQuote>): Promise<SwapSizing> {
  const offerFor = (usdcIn: number, answer: SwapQuote): SwapOffer => ({
    usdcIn,
    eurcEstimated: answer.eurcEstimated,
    eurcMinimum: answer.eurcMinimum,
    usdcPerEurc,
    costPercent: swapCostPercent(usdcIn, answer.eurcEstimated, usdcPerEurc),
    provider: answer.provider,
  });
  try {
    let usdcIn = micro((short * usdcPerEurc) / (1 - SWAP_SLIPPAGE_BPS / 10_000));
    let answer = await quote(usdcIn);
    if (answer.eurcMinimum < short && answer.eurcMinimum > 0) {
      usdcIn = micro(((usdcIn * short) / answer.eurcMinimum) * 1.005);
      answer = await quote(usdcIn);
    }
    if (answer.eurcMinimum < short) {
      return { offer: null, reason: `${SWAP_MINIMUM_SHORT} ${answer.eurcMinimum} EURC, would not cover the ${short} EURC needed.` };
    }
    return { offer: offerFor(usdcIn, answer) };
  } catch (error) {
    if (!(error instanceof FxQuoteError)) throw error;
    return {
      offer: null,
      reason:
        error.code === "no_route" ? NO_SWAP_ROUTE : error.code === "malformed" ? SWAP_QUOTE_UNREADABLE : SWAP_QUOTE_UNANSWERED,
    };
  }
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const integer = z.string().regex(/^(0x[0-9a-fA-F]+|\d+)$/);
const swapSchema = z.object({
  amount: baseUnits,
  estimatedAmount: baseUnits,
  stopLimit: baseUnits,
  route: z.object({ provider: z.string().optional() }).passthrough().optional(),
  transaction: z.object({
    signature: hex,
    executionParams: z.object({
      execId: integer,
      deadline: integer,
      metadata: hex,
      tokens: z.array(z.object({ token: address, beneficiary: address })),
      instructions: z.array(
        z.object({ target: address, data: hex, value: integer, tokenIn: address, amountToApprove: integer, tokenOut: address, minTokenOut: integer })
      ),
    }),
  }),
});

/**
 * The swap of exactly `usdcIn` USDC for EURC, as the service signs it, encoded for the Adapter. Refuses
 * an answer that would send any token to anyone but the wallet. Throws `FxQuoteError`.
 */
export async function createSwapTransaction(usdcIn: number, options: AskOptions): Promise<SwapTransaction> {
  const units = toBaseUnits(usdcIn);
  const body = JSON.stringify({
    tokenInAddress: ARC_TESTNET_USDC,
    tokenInChain: "Arc_Testnet",
    tokenOutAddress: ARC_TESTNET_EURC,
    tokenOutChain: "Arc_Testnet",
    fromAddress: options.fromAddress,
    toAddress: options.fromAddress,
    amount: units,
    slippageBps: SWAP_SLIPPAGE_BPS,
  });
  return once(async () => {
    const parsed = swapSchema.safeParse(await ask(SWAP_URL, { method: "POST", headers: { "content-type": "application/json" }, body }, options));
    if (!parsed.success) throw new FxQuoteError("malformed");
    const { executionParams, signature } = parsed.data.transaction;
    const wallet = options.fromAddress.toLowerCase();
    const eurc = ARC_TESTNET_EURC.toLowerCase();
    // What is signed is checked, not only what is reported (review #5): the amount asked for; no
    // instruction approving more USDC than it; every token returned to the wallet, EURC among them;
    // and the EURC the chain enforces, which is the minimum relied on.
    if (parsed.data.amount !== units) throw new FxQuoteError("malformed");
    if (executionParams.tokens.some((token) => token.beneficiary.toLowerCase() !== wallet)) throw new FxQuoteError("malformed");
    if (!executionParams.tokens.some((token) => token.token.toLowerCase() === eurc)) throw new FxQuoteError("malformed");
    const approved = executionParams.instructions.reduce((sum, instruction) => sum + BigInt(instruction.amountToApprove), BigInt(0));
    if (approved > BigInt(units)) throw new FxQuoteError("malformed");
    const enforced = executionParams.instructions
      .filter((instruction) => instruction.tokenOut.toLowerCase() === eurc)
      .reduce((sum, instruction) => sum + BigInt(instruction.minTokenOut), BigInt(0));
    if (enforced === BigInt(0)) throw new FxQuoteError("malformed");
    const stopLimit = BigInt(parsed.data.stopLimit);
    const callData = encodeFunctionData({
      abi: ADAPTER_EXECUTE_ABI,
      functionName: "execute",
      args: [
        {
          instructions: executionParams.instructions.map((instruction) => ({
            target: instruction.target as Hex,
            data: instruction.data as Hex,
            value: BigInt(instruction.value),
            tokenIn: instruction.tokenIn as Hex,
            amountToApprove: BigInt(instruction.amountToApprove),
            tokenOut: instruction.tokenOut as Hex,
            minTokenOut: BigInt(instruction.minTokenOut),
          })),
          tokens: executionParams.tokens.map((token) => ({ token: token.token as Hex, beneficiary: token.beneficiary as Hex })),
          execId: BigInt(executionParams.execId),
          deadline: BigInt(executionParams.deadline),
          metadata: executionParams.metadata as Hex,
        },
        [{ permitType: 0, token: ARC_TESTNET_USDC as Hex, amount: BigInt(units), permitCalldata: "0x" }],
        signature as Hex,
      ],
    });
    return {
      eurcEstimated: fromBaseUnits(parsed.data.estimatedAmount),
      eurcMinimum: fromBaseUnits((enforced < stopLimit ? enforced : stopLimit).toString()),
      provider: parsed.data.route?.provider ?? null,
      adapter: ADAPTER,
      callData,
      deadline: new Date(Number(BigInt(executionParams.deadline)) * 1000),
    };
  }, options.retryDelayMs);
}
