import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { decodeHeader, encodeHeader, sameOffer, X402_NETWORK, type X402Requirements } from "./offer";

/**
 * The agent paying for an x402 resource (docs/superpowers/specs/2026-10-02-x402-payee-history-design.md R4, R5):
 * ask, read the 402's offer, check it in code, sign Circle Gateway's batched authorization, ask again with it.
 * Code refuses before anything is signed when the seller is not allowed, the offer is not the expected one, the
 * price is above the most, or `beforePay` refuses (the day's budget, the purse). Nothing here moves money
 * except Gateway settling the one authorization signed.
 */

export type PurchaseRule = "seller.not_allowed" | "offer.mismatch" | "price.above_max" | "budget.day" | "purse.short";

/** A purchase code would not make; nothing was signed. */
export class PurchaseRefused extends Error {
  readonly name = "PurchaseRefused";
  constructor(
    readonly rule: PurchaseRule,
    message: string
  ) {
    super(message);
  }
}

/** What signs the authorization: an EOA (Gateway checks with ecrecover), here a Circle wallet through `signTypedData`. */
export interface X402Signer {
  address: string;
  signTypedData(params: { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown> }): Promise<string>;
}

export interface Purchase<T> {
  data: T;
  priceUsdc: number;
  payer: string;
  payTo: string;
  nonce: string;
  /** Gateway's settlement, from the seller's PAYMENT-RESPONSE; null when it named none. */
  settlement: string | null;
}

interface PaymentRequired {
  x402Version?: number;
  resource?: unknown;
  accepts?: Array<Record<string, unknown>>;
}

const REQUEST_DEADLINE_MS = 20_000;

export async function buyX402<T>(input: {
  url: string;
  /** The seller's offer as the buyer expects it: the price, payee, network and contract (R5). */
  expected: X402Requirements;
  maxPriceUsdc: number;
  allowed: (url: URL) => boolean;
  signer: X402Signer;
  /** Last word before signing, with the price; throws `PurchaseRefused` to stop. */
  beforePay?: (priceUsdc: number) => Promise<void>;
  fetch?: typeof fetch;
}): Promise<Purchase<T>> {
  const fetcher = input.fetch ?? fetch;
  const url = new URL(input.url);
  if (!input.allowed(url)) throw new PurchaseRefused("seller.not_allowed", `${url.origin}${url.pathname} is not a seller the agent may pay.`);

  const ask = (headers: Record<string, string> = {}) =>
    fetcher(url, { method: "GET", headers: { Accept: "application/json", ...headers }, cache: "no-store", signal: AbortSignal.timeout(REQUEST_DEADLINE_MS) });

  const first = await ask();
  if (first.status !== 402) throw new Error(`The seller answered ${first.status} before payment, not 402.`);
  const required = decodeHeader<PaymentRequired>(first.headers.get("PAYMENT-REQUIRED"));
  const offer = required?.accepts?.find((option) => option.network === X402_NETWORK && (option.extra as { name?: string } | undefined)?.name === input.expected.extra.name);
  if (!offer || !sameOffer(offer, input.expected)) {
    throw new PurchaseRefused("offer.mismatch", "The seller's offer is not the one the agent may accept: another price, payee, network or contract.");
  }
  const priceUsdc = Number(offer.amount) / 1_000_000;
  if (!(priceUsdc > 0) || priceUsdc > input.maxPriceUsdc) {
    throw new PurchaseRefused("price.above_max", `The seller asks ${priceUsdc} USDC, above the ${input.maxPriceUsdc} USDC the agent may pay for one call.`);
  }
  await input.beforePay?.(priceUsdc);

  const scheme = new BatchEvmScheme({
    address: input.signer.address as `0x${string}`,
    signTypedData: async (params) => (await input.signer.signTypedData(params)) as `0x${string}`,
  });
  const x402Version = required?.x402Version ?? 2;
  const signed = await scheme.createPaymentPayload(x402Version, offer as unknown as Parameters<BatchEvmScheme["createPaymentPayload"]>[1]);
  const authorization = (signed.payload as { authorization?: { from?: string; to?: string; nonce?: string } }).authorization ?? {};
  const paid = await ask({ "Payment-Signature": encodeHeader({ ...signed, resource: required?.resource, accepted: offer }) });
  const body = (await paid.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!paid.ok || body === null) {
    throw new Error(`The seller did not accept the payment (${paid.status}): ${body?.error ?? "no reason given"}`);
  }
  const settled = decodeHeader<{ transaction?: string | null }>(paid.headers.get("PAYMENT-RESPONSE"));
  return {
    data: body,
    priceUsdc,
    payer: authorization.from ?? input.signer.address,
    payTo: String(offer.payTo),
    nonce: authorization.nonce ?? "",
    settlement: settled?.transaction ?? null,
  };
}

/** A typed-data request as Circle's `signTypedData` takes it: JSON, with the EIP712Domain type, numbers as strings. */
export function circleTypedData(params: Parameters<X402Signer["signTypedData"]>[0]): string {
  const domainFields = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ].filter((field) => field.name in params.domain);
  return JSON.stringify(
    { types: { EIP712Domain: domainFields, ...params.types }, domain: params.domain, primaryType: params.primaryType, message: params.message },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value)
  );
}
