import { decodeFunctionData } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ARC_TESTNET_EURC, ARC_TESTNET_USDC, FxQuoteError } from "@/lib/fx/quote";
import {
  ADAPTER,
  ADAPTER_EXECUTE_ABI,
  createSwapTransaction,
  quoteUsdcForEurc,
  sizeSwap,
  SWAP_COST_CAP_PERCENT,
  type SwapQuote,
} from "@/lib/fx/swap-service";
import answer from "./fixtures/stablecoin-swap-answer.json";

/**
 * Circle's Stablecoin Service for a USDC→EURC swap on Arc testnet (docs/superpowers/specs/2026-10-01-eurc-swap-design.md
 * S1, S6): a quote sized so the swap's minimum covers what the wallet is short of, then the swap's
 * transaction, sent as App Kit's adapters send it. The answer below is the service's own, captured
 * 2026-10-01: 1 USDC → 0.822815 EURC estimated, 0.798131 at least, through LI.FI.
 */

const FROM = "0x1111111111111111111111111111111111111111";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const quoteAnswer = (estimated: string, minimum: string) => json({ quote: { estimatedAmount: estimated, minAmount: minimum, route: { provider: "lifi", steps: [] } } });
const noRoute = () => json({ code: 331001, message: "No route available" }, 404);

describe("the Adapter App Kit names for Arc testnet", () => {
  it("is the address in @circle-fin/app-kit's chain definition", () => {
    expect(ADAPTER).toBe("0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b");
  });
});

describe("quoteUsdcForEurc", () => {
  it("asks for USDC→EURC on Arc testnet in base units, and reads the amounts exactly", async () => {
    const fetch = vi.fn().mockResolvedValue(quoteAnswer("2058000", "1996260"));
    const quote = await quoteUsdcForEurc(2.5, { fromAddress: FROM, fetch });

    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.circle.com/v1/stablecoinKits/quote");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tokenInAddress: ARC_TESTNET_USDC,
      tokenInChain: "Arc_Testnet",
      tokenOutAddress: ARC_TESTNET_EURC,
      tokenOutChain: "Arc_Testnet",
      fromAddress: FROM,
      toAddress: FROM,
      amount: "2500000",
      slippageBps: "300",
    });
    expect(quote).toEqual({ eurcEstimated: 2.058, eurcMinimum: 1.99626, provider: "lifi" });
  });

  it("asks once more when there is no route, as Arc testnet's route comes and goes", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(noRoute()).mockResolvedValueOnce(quoteAnswer("822815", "798131"));
    const quote = await quoteUsdcForEurc(1, { fromAddress: FROM, fetch, retryDelayMs: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(quote.eurcEstimated).toBe(0.822815);
  });

  it("says there is no route when the second answer is the same", async () => {
    const fetch = vi.fn().mockImplementation(async () => noRoute());
    await expect(quoteUsdcForEurc(1, { fromAddress: FROM, fetch, retryDelayMs: 0 })).rejects.toMatchObject({ code: "no_route" });
  });

  it("calls a rate limit unavailable", async () => {
    const fetch = vi.fn().mockImplementation(async () => json({ code: 5, message: "API rate limit error" }, 429));
    await expect(quoteUsdcForEurc(1, { fromAddress: FROM, fetch, retryDelayMs: 0 })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("sends the workspace's Circle key as a bearer token, and asks without it when the service refuses the key", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ code: 401, message: "Unauthorized" }, 401)).mockResolvedValueOnce(quoteAnswer("822815", "798131"));
    await quoteUsdcForEurc(1, { fromAddress: FROM, fetch, apiKey: "TEST_API_KEY:id:secret", retryDelayMs: 0 });
    expect((fetch.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: "Bearer TEST_API_KEY:id:secret" });
    expect((fetch.mock.calls[1][1] as RequestInit).headers).not.toHaveProperty("authorization");
  });
});

describe("sizeSwap", () => {
  const rate = 1.216081; // USDC per EURC, the rate the payable was weighed at

  it("asks for enough USDC that the swap's minimum covers what the wallet is short of", async () => {
    const quote = vi.fn(async (usdcIn: number): Promise<SwapQuote> => ({ eurcEstimated: usdcIn * 0.8228, eurcMinimum: usdcIn * 0.7981, provider: "lifi" }));
    const sized = await sizeSwap(2, rate, quote);

    // 2 EURC at 1.216081, over the 3% slippage floor, rounded up to the micro-USDC.
    expect(quote).toHaveBeenCalledWith(2.507384);
    expect(sized.offer).toMatchObject({ usdcIn: 2.507384, provider: "lifi", usdcPerEurc: rate });
    expect(sized.offer!.eurcMinimum).toBeGreaterThanOrEqual(2);
  });

  it("asks once more with more USDC when the first minimum falls short", async () => {
    const quote = vi
      .fn<(usdcIn: number) => Promise<SwapQuote>>()
      .mockResolvedValueOnce({ eurcEstimated: 1.96, eurcMinimum: 1.9, provider: "lifi" })
      .mockImplementationOnce(async (usdcIn) => ({ eurcEstimated: usdcIn * 0.82, eurcMinimum: usdcIn * 0.7955, provider: "lifi" }));
    const sized = await sizeSwap(2, rate, quote);

    expect(quote).toHaveBeenCalledTimes(2);
    // Scaled by what was missing, with half a percent to spare: 2.507384 × 2 / 1.9 × 1.005, rounded up.
    expect(quote.mock.calls[1][0]).toBe(2.652549);
    expect(sized.offer!.eurcMinimum).toBeGreaterThanOrEqual(2);
  });

  it("offers nothing, and says why, when the second minimum still falls short", async () => {
    const quote = vi.fn(async (): Promise<SwapQuote> => ({ eurcEstimated: 1, eurcMinimum: 0.9, provider: "lifi" }));
    expect(await sizeSwap(2, rate, quote)).toEqual({ offer: null, reason: "The swap's minimum, 0.9 EURC, would not cover the 2 EURC needed." });
  });

  it("offers nothing when there is no route", async () => {
    const quote = vi.fn(async (): Promise<SwapQuote> => {
      throw new FxQuoteError("no_route");
    });
    expect(await sizeSwap(2, rate, quote)).toEqual({ offer: null, reason: "No USDC→EURC route on Arc testnet right now." });
  });

  it("prices each EURC through the swap against the rate the payable was weighed at", async () => {
    // 2.507384 USDC for 2.06 EURC is 1.217177 a EURC: 0.09% above 1.216081.
    const quote = vi.fn(async (): Promise<SwapQuote> => ({ eurcEstimated: 2.06, eurcMinimum: 2.0, provider: "lifi" }));
    const sized = await sizeSwap(2, rate, quote);
    expect(sized.offer!.costPercent).toBe(0.09);
    expect(SWAP_COST_CAP_PERCENT).toBe(3);
  });
});

describe("createSwapTransaction", () => {
  const swapAnswer = () => json(answer);

  it("asks for the swap of exactly this USDC, and returns the Adapter call App Kit's adapters send", async () => {
    const fetch = vi.fn().mockResolvedValue(swapAnswer());
    const swap = await createSwapTransaction(1, { fromAddress: FROM, fetch });

    expect(fetch.mock.calls[0][0]).toBe("https://api.circle.com/v1/stablecoinKits/swap");
    const request = fetch.mock.calls[0][1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body as string)).toEqual({
      tokenInAddress: ARC_TESTNET_USDC,
      tokenInChain: "Arc_Testnet",
      tokenOutAddress: ARC_TESTNET_EURC,
      tokenOutChain: "Arc_Testnet",
      fromAddress: FROM,
      toAddress: FROM,
      amount: "1000000",
      slippageBps: 300,
    });
    expect(swap).toMatchObject({ eurcEstimated: 0.822815, eurcMinimum: 0.798131, adapter: ADAPTER, provider: "lifi" });
    expect(swap.deadline.toISOString()).toBe(new Date(Number(answer.transaction.executionParams.deadline) * 1000).toISOString());

    const call = decodeFunctionData({ abi: ADAPTER_EXECUTE_ABI, data: swap.callData });
    expect(swap.callData.slice(0, 10)).toBe("0xaa3e079c");
    expect(call.functionName).toBe("execute");
    const [params, tokenInputs, signature] = call.args;
    const sent = answer.transaction.executionParams;
    expect(params.execId).toBe(BigInt(sent.execId));
    expect(params.deadline).toBe(BigInt(sent.deadline));
    expect(params.tokens.map((token) => token.beneficiary.toLowerCase())).toEqual([FROM, FROM]);
    expect(params.instructions.map((instruction) => [instruction.target, instruction.data, instruction.value, instruction.amountToApprove, instruction.minTokenOut])).toEqual(
      sent.instructions.map((instruction) => [instruction.target, instruction.data, BigInt(instruction.value), BigInt(instruction.amountToApprove), BigInt(instruction.minTokenOut)])
    );
    // Approved beforehand, so no permit: App Kit's PermitType.NONE.
    expect(tokenInputs).toEqual([{ permitType: 0, token: ARC_TESTNET_USDC, amount: BigInt(1_000_000), permitCalldata: "0x" }]);
    expect(signature).toBe(answer.transaction.signature);
  });

  it("refuses a swap that would send a token to anyone but the wallet", async () => {
    const elsewhere = structuredClone(answer);
    elsewhere.transaction.executionParams.tokens[1].beneficiary = "0x2222222222222222222222222222222222222222";
    const fetch = vi.fn().mockResolvedValue(json(elsewhere));
    await expect(createSwapTransaction(1, { fromAddress: FROM, fetch })).rejects.toMatchObject({ code: "malformed" });
  });

  it("refuses an answer with no transaction to send", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ ...answer, transaction: { data: "0x00" } }));
    await expect(createSwapTransaction(1, { fromAddress: FROM, fetch })).rejects.toMatchObject({ code: "malformed" });
  });

  it("asks once more when there is no route", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(noRoute()).mockResolvedValueOnce(swapAnswer());
    await createSwapTransaction(1, { fromAddress: FROM, fetch, retryDelayMs: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
