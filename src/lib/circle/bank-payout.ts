import { createHash } from "node:crypto";
import { createEvmPayout, createQuote, getPayout } from "../blindpay/api";
import { BlindpayError, type BlindpayHttp } from "../blindpay/http";
import { payoutOutcome, type BlindpayPayout, type BlindpayQuote } from "../blindpay/map";
import { blindpaySettingsFromEnv, type BlindpaySettings } from "../blindpay/settings";
import type { ContractCall } from "./cctp";
import { MAY_HAVE_BEEN_ACCEPTED, type Settlement } from "./settlement";
import type { BankPayoutParams, BankPayoutRecord, TransferParams, TransferResult } from "./types";

/**
 * A vendor's bill paid to its bank account through BlindPay (docs/superpowers/specs/2026-10-16-bank-payouts-design.md
 * B7, B8): a fresh quote for the invoice amount, refused when what leaves is not the invoice's; the approve of BlindPay's
 * contract for the quote's amount, from the operating wallet, under a key derived from the attempt's; then the payout,
 * under its own derived `Idempotency-Key`, so a retried attempt never makes a second payout. The quote moves nothing and
 * carries no key: a try after one expired gets a new one. The intent's provider id is `blindpay:<payout id>`, which
 * reconciliation reads back and never sends again.
 */

export const BANK_ID = "blindpay:";

export class BankPayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankPayoutError";
  }
}

/**
 * The key of one step of a bank payout attempt (B7): a UUID derived from the attempt's own key and the step, as Circle
 * takes idempotency keys only as UUIDs, the same for every try of the attempt and different for each step.
 */
export function bankStepKey(attemptKey: string, step: "approve" | "payout"): string {
  const hash = createHash("sha256").update(`vestiarion/bank/v1/${attemptKey}/${step}`, "utf8").digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const cents = (amount: number) => Math.round(amount * 100);

/** The quote and payout as the ledger and the card keep them (B10). */
export function bankRecord(quote: BlindpayQuote, payoutId: string, route: BankPayoutParams): BankPayoutRecord {
  return {
    provider: "blindpay",
    quoteId: quote.id,
    payoutId,
    receiverAmount: quote.receiverAmount,
    currency: "MXN",
    rate: quote.rate,
    feesReceiver: quote.feesReceiver,
    network: route.network,
    token: route.token,
  };
}

/** A payout in the provider's shape: paid on BlindPay's `completed`, failed on `failed` or `refunded` (B8). */
export function bankPayoutResult(providerTxId: string, payout: BlindpayPayout, chain: string, record: BankPayoutRecord | null = null, started: number | null = null): TransferResult {
  const status = payoutOutcome(payout.status);
  return {
    providerTxId,
    txHash: payout.txHash,
    txRef: payout.txHash ?? providerTxId,
    chain,
    status,
    feeUsd: 0,
    feeSource: "provider_estimate",
    providerMode: "live",
    settledInMs: status === "confirmed" && started !== null ? Date.now() - started : null,
    // A payout BlindPay refunded moved no pesos, and its USDC is back: it reads as Circle's own terminal failure, so a
    // person's Approve and pay opens the next attempt under a new key, as for any transfer (payment attempts, migration
    // 0036). One BlindPay failed still holds the USDC until BlindPay refunds it (B8): it is failed, never sent again, and
    // read until it is refunded.
    providerState: payout.status === "refunded" ? "FAILED" : payout.status,
    failureReason:
      payout.status === "refunded"
        ? (payout.reason ?? "BlindPay refunded the payout")
        : status === "failed"
          ? `${payout.reason ?? "BlindPay failed the payout"}; BlindPay holds the USDC until it refunds it`
          : null,
    route: "bank",
    ...(record ? { bankPayout: record } : {}),
  };
}

/** `keccak256("balanceOf(address)")`'s first four bytes. */
const BALANCE_OF = "0x70a08231";

/**
 * What `owner` holds of `token`, in its base units, read from the chain's RPC; null when it cannot be read. The token a
 * bank payout takes is the quote's (B7): USDB, BlindPay's test token, on Arc testnet; USDC on Arc mainnet.
 */
export async function readTokenBalance(rpcUrl: string, token: string, owner: string, fetchImpl: typeof fetch = fetch): Promise<bigint | null> {
  try {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data: `${BALANCE_OF}${owner.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"] }),
      signal: AbortSignal.timeout(4_000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const result = ((await response.json()) as { result?: unknown }).result;
    return typeof result === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(result) ? BigInt(result) : null;
  } catch {
    return null;
  }
}

function settingsOrThrow(): BlindpaySettings {
  const settings = blindpaySettingsFromEnv();
  if (!settings) throw new BankPayoutError("Bank payouts are not set up on this deployment: nothing was sent.");
  return settings;
}

/**
 * Pays `params.amount` to the bank account (B7). The operating wallet's address is the sender BlindPay takes the
 * tokens from; `approve` runs a Circle contract execution and waits for it to settle. A quote or payout BlindPay refuses
 * sends nothing, and says why.
 */
export async function payToBank(
  params: TransferParams,
  route: BankPayoutParams,
  account: { address?: string | null; chain: string },
  deps: BlindpayHttp & {
    approve: (call: ContractCall, key: string) => Promise<Settlement>;
    /** What the sender holds of the quote's token on the quote's chain, in base units; null when it cannot be read there. */
    tokenBalance?: (token: string, owner: string, chainId: number | null) => Promise<bigint | null>;
    settings?: BlindpaySettings;
    waitMs?: number;
  }
): Promise<TransferResult> {
  const settings = deps.settings ?? settingsOrThrow();
  const sender = account.address;
  if (!sender || !/^0x[0-9a-fA-F]{40}$/.test(sender)) throw new BankPayoutError("The operating wallet has no address to pay BlindPay from: nothing was sent.");
  const started = Date.now();

  let quote: BlindpayQuote;
  try {
    quote = await createQuote(settings, { bankAccountId: route.bankAccountId, amount: params.amount, network: route.network, token: route.token }, undefined, deps);
  } catch (error) {
    throw new BankPayoutError(`BlindPay gave no quote for this payout${error instanceof BlindpayError && error.code ? ` (${error.code})` : ""}: nothing was sent.`);
  }
  // The business pays the invoice's amount exactly; anything else is not the payment a person approved (B7).
  if (cents(quote.senderAmount) !== cents(params.amount)) {
    throw new BankPayoutError(`BlindPay quoted ${quote.senderAmount} to leave for a ${params.amount} payment: nothing was sent.`);
  }
  if (quote.expiresAtMs <= Date.now()) throw new BankPayoutError("BlindPay's quote expired before the payout: nothing was sent. Approve again for a new quote.");
  // What BlindPay takes is the quote's token, which on Arc testnet is not USDC: the wallet must hold that much of it, or
  // nothing is approved (B7). A balance that cannot be read leaves it to BlindPay, which refuses a payout it cannot take.
  const held = deps.tokenBalance ? await deps.tokenBalance(quote.contract.token, sender, quote.contract.chainId) : null;
  if (held !== null && held < BigInt(quote.contract.amount)) {
    throw new BankPayoutError(`The operating wallet holds less ${route.token} than this payout takes: nothing was sent. Fund it with ${route.token} first.`);
  }

  const approve: ContractCall = { contractAddress: quote.contract.token, abiFunctionSignature: "approve(address,uint256)", abiParameters: [quote.contract.spender, quote.contract.amount] };
  const approved = await deps.approve(approve, bankStepKey(params.idempotencyKey, "approve"));
  if (approved.status !== "confirmed") {
    throw new BankPayoutError(approved.status === "failed" ? "The approve for BlindPay failed: nothing was paid." : "Circle has not confirmed the approve for BlindPay yet: nothing was paid.");
  }

  // BlindPay may not see the approve at once: it says so (`PAYOUTS_ALLOWANCE_NOT_CONFIRMED`), and the same payout is asked
  // for again under the same key, which BlindPay makes once.
  const waitMs = deps.waitMs ?? 3_000;
  for (let tries = 0; ; tries += 1) {
    try {
      const payout = await createEvmPayout(settings, { quoteId: quote.id, senderWalletAddress: sender }, bankStepKey(params.idempotencyKey, "payout"), deps);
      return bankPayoutResult(`${BANK_ID}${payout.id}`, payout, account.chain, bankRecord(quote, payout.id, route), started);
    } catch (error) {
      const retry = error instanceof BlindpayError && (error.code === "PAYOUTS_ALLOWANCE_NOT_CONFIRMED" || error.code === "idempotency_key_in_flight") && tries < 4;
      if (!retry) {
        // A key BlindPay already holds a payout under, or a request it never answered: the payout may exist, so the
        // payment stays in flight and is asked for again under the same key, never closed as unpaid (B7).
        if (error instanceof BlindpayError && error.code?.toLowerCase().includes("idempotency")) {
          throw new Error(`BlindPay already holds a payout under this payment's key (${error.code}), so it ${MAY_HAVE_BEEN_ACCEPTED}; check it with BlindPay before paying it another way.`);
        }
        if (error instanceof BlindpayError && !error.retryable) {
          throw new BankPayoutError(`BlindPay refused the payout${error.code ? ` (${error.code})` : ""}: nothing was paid.`);
        }
        throw new Error(`BlindPay did not answer the payout request, so it ${MAY_HAVE_BEEN_ACCEPTED}; it is asked for again under the same key.`);
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/** A bank payout read back from BlindPay by its provider id (B8). */
export async function reconcileBankPayout(providerTxId: string, deps: BlindpayHttp & { settings?: BlindpaySettings } = {}): Promise<BlindpayPayout> {
  const settings = deps.settings ?? settingsOrThrow();
  return getPayout(settings, providerTxId.slice(BANK_ID.length), deps);
}
