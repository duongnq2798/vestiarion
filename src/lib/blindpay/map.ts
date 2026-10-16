/**
 * BlindPay's JSON in Vestiarion's shapes (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B5, B7, B8). Pure:
 * the HTTP lives in `./http.ts`. Whatever does not read is refused as a bad answer, never guessed: an amount, a contract
 * address or a status Vestiarion does not know stops the payment before anything is sent.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const id = (value: unknown, prefix: string): string | null => {
  const written = text(value);
  return written && written.startsWith(prefix) && /^[A-Za-z0-9_]{4,64}$/.test(written) ? written : null;
};
const address = (value: unknown): string | null => {
  const written = text(value);
  return written && /^0x[0-9a-fA-F]{40}$/.test(written) ? written : null;
};

/** An amount in minor units (cents of the currency), as BlindPay writes it, as a number of whole units. */
const minor = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value / 100 : null);

/** `expires_at` as epoch milliseconds: BlindPay's docs write milliseconds, its OpenAPI seconds (the brief's conflict). */
export function expiresAtMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}

export class BlindpayAnswerError extends Error {
  constructor(what: string) {
    super(`BlindPay's ${what} answer did not read`);
    this.name = "BlindpayAnswerError";
  }
}

/** A payout quote: what leaves in the token, what the vendor receives in pesos, and the approve it asks for. */
export interface BlindpayQuote {
  id: string;
  expiresAtMs: number;
  /** What leaves the sender, in whole token units (USDC or USDB). */
  senderAmount: number;
  /** What the bank account receives, in whole units of its currency. */
  receiverAmount: number;
  /** Pesos per token unit, BlindPay's own quotation. */
  rate: number | null;
  /** BlindPay's fees, in the receiver's currency: its flat fee and billing fee. */
  feesReceiver: number;
  contract: { token: string; spender: string; amount: string; network: string; chainId: number | null };
}

export function mapQuote(body: unknown): BlindpayQuote {
  if (!isObject(body)) throw new BlindpayAnswerError("quote");
  const quoteId = id(body.id, "qu_");
  const expires = expiresAtMs(body.expires_at);
  const sender = minor(body.sender_amount);
  const receiver = minor(body.receiver_amount);
  const contract = isObject(body.contract) ? body.contract : null;
  const token = contract ? address(contract.address) : null;
  const spender = contract ? address(contract.blindpayContractAddress) : null;
  const units = contract && typeof contract.amount === "string" && /^\d{1,40}$/.test(contract.amount) ? contract.amount : null;
  const network = contract && isObject(contract.network) ? contract.network : null;
  if (!quoteId || expires === null || sender === null || receiver === null || !token || !spender || !units) throw new BlindpayAnswerError("quote");
  const rate = typeof body.blindpay_quotation === "number" && body.blindpay_quotation > 0 ? body.blindpay_quotation : typeof body.commercial_quotation === "number" && body.commercial_quotation > 0 ? body.commercial_quotation : null;
  return {
    id: quoteId,
    expiresAtMs: expires,
    senderAmount: sender,
    receiverAmount: receiver,
    rate: rate === null ? null : rate / 100,
    feesReceiver: (minor(body.flat_fee) ?? 0) + (minor(body.billing_fee_amount) ?? 0),
    contract: {
      token,
      spender,
      amount: units,
      network: (network && text(network.name)) ?? "",
      chainId: network && typeof network.chainId === "number" ? network.chainId : null,
    },
  };
}

export type BlindpayPayoutStatus = "processing" | "on_hold" | "completed" | "failed" | "refunded";

/** A payout as Vestiarion follows it: its status, and what BlindPay says of the money on chain and at the bank. */
export interface BlindpayPayout {
  id: string;
  status: BlindpayPayoutStatus;
  /** The on-chain transaction that took the tokens, once BlindPay found it. */
  txHash: string | null;
  /** Why a payout failed or was refunded, in BlindPay's words. */
  reason: string | null;
  /** When the bank should have it, as BlindPay estimates. */
  estimatedArrival: string | null;
}

const STATUSES: readonly BlindpayPayoutStatus[] = ["processing", "on_hold", "completed", "failed", "refunded"];

export function mapPayout(body: unknown): BlindpayPayout {
  if (!isObject(body)) throw new BlindpayAnswerError("payout");
  const payoutId = id(body.id, "po_");
  const status = STATUSES.find((candidate) => candidate === body.status);
  if (!payoutId || !status) throw new BlindpayAnswerError("payout");
  const transaction = isObject(body.tracking_transaction) ? body.tracking_transaction : {};
  const payment = isObject(body.tracking_payment) ? body.tracking_payment : {};
  const complete = isObject(body.tracking_complete) ? body.tracking_complete : {};
  const hash = text(transaction.transaction_hash) ?? text(complete.transaction_hash);
  const reason = text(complete.refund_reason) ?? text(payment.provider_error_reason) ?? text(transaction.provider_error_reason);
  return {
    id: payoutId,
    status,
    txHash: hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash : null,
    reason: reason ? reason.slice(0, 200) : null,
    estimatedArrival: text(payment.estimated_time_of_arrival),
  };
}

/** How a payout stands for a payment: paid, failed, or still on its way. */
export function payoutOutcome(status: BlindpayPayoutStatus): "confirmed" | "failed" | "pending" {
  if (status === "completed") return "confirmed";
  if (status === "failed" || status === "refunded") return "failed";
  return "pending";
}

/** A bank account as BlindPay holds it: its id and whether a quote may use it yet. */
export function mapBankAccount(body: unknown): { id: string; status: "verifying" | "approved" | "rejected" | "deprecated" } {
  if (!isObject(body)) throw new BlindpayAnswerError("bank account");
  const accountId = id(body.id, "ba_");
  const status = body.status === "approved" || body.status === "rejected" || body.status === "deprecated" ? body.status : "verifying";
  if (!accountId) throw new BlindpayAnswerError("bank account");
  return { id: accountId, status };
}

export type KybStatus = "verifying" | "approved" | "rejected" | "pending_review" | "other";

export function mapCustomer(body: unknown): { id: string; kybStatus: KybStatus } {
  if (!isObject(body)) throw new BlindpayAnswerError("customer");
  const customerId = id(body.id, "re_") ?? id(body.customer_id, "re_");
  if (!customerId) throw new BlindpayAnswerError("customer");
  const status = body.kyc_status;
  const kybStatus: KybStatus = status === "approved" || status === "verifying" || status === "rejected" || status === "pending_review" ? status : status === undefined ? "verifying" : "other";
  return { id: customerId, kybStatus };
}
