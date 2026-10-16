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

/** The key of one step of a bank payout attempt (B7): the attempt's own key, then the step. */
export function bankStepKey(attemptKey: string, step: "approve" | "payout"): string {
  return `${attemptKey}/bank-${step}`.slice(0, 255);
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
  deps: BlindpayHttp & { approve: (call: ContractCall, key: string) => Promise<Settlement>; settings?: BlindpaySettings; waitMs?: number }
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
