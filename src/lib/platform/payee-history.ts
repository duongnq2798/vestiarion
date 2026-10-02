import { platformDb } from "../dal";
import {
  decodeHeader,
  encodeHeader,
  isArcAddress,
  PAYEE_HISTORY_PATH,
  PAYEE_HISTORY_PRICE_USDC,
  payeeHistoryRequirements,
  sameOffer,
  type X402Requirements,
} from "../x402/offer";

/**
 * Vestiarion selling payee history over x402 (docs/superpowers/specs/2026-10-02-x402-payee-history-design.md
 * §2, R1, R2): without a payment, the offer; with one, Circle's facilitator verifies it, the history is read,
 * the payment is settled, and only then is the answer given, with the settlement. A payment that does not
 * verify or settle gets the offer's 402 again, and no history.
 */

export interface PayeeHistory {
  address: string;
  workspacesPaid: number;
  paymentsConfirmed: number;
  firstPaidAt: string | null;
  lastPaidAt: string | null;
  asOf: string;
}

/** What the seller needs from Circle's facilitator: `BatchFacilitatorClient`, or a test's own. */
export interface Facilitator {
  verify(payload: unknown, requirements: X402Requirements): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>;
  settle(payload: unknown, requirements: X402Requirements): Promise<{ success: boolean; errorReason?: string; payer?: string; transaction?: string; network?: string }>;
}

export interface SellerAnswer {
  status: 200 | 400 | 402 | 503;
  headers: Record<string, string>;
  body: unknown;
}

interface PaymentPayload {
  x402Version?: number;
  accepted?: unknown;
  payload?: { authorization?: { from?: string; nonce?: string } };
}

const json = { "Content-Type": "application/json", "Cache-Control": "no-store" };

/** R1's aggregate for an address, read across every workspace by the service role. */
export async function readPayeeHistory(address: string): Promise<PayeeHistory> {
  const result = await platformDb().rpc("payee_history", { p_address: address });
  if (result.error) throw new Error(result.error.message);
  const row = (result.data ?? {}) as { workspacesPaid?: number; paymentsConfirmed?: number; firstPaidAt?: string | null; lastPaidAt?: string | null };
  return {
    address,
    workspacesPaid: Number(row.workspacesPaid ?? 0),
    paymentsConfirmed: Number(row.paymentsConfirmed ?? 0),
    firstPaidAt: row.firstPaidAt ?? null,
    lastPaidAt: row.lastPaidAt ?? null,
    asOf: new Date().toISOString(),
  };
}

export async function sellPayeeHistory(
  input: { address: string | null; paymentHeader: string | null; origin: string },
  deps: { facilitator: Facilitator; read?: (address: string) => Promise<PayeeHistory>; record?: (sale: Sale) => Promise<void> }
): Promise<SellerAnswer> {
  if (!isArcAddress(input.address)) {
    return { status: 400, headers: json, body: { error: "Name the Arc address to look up: ?address=0x… (40 hex characters)." } };
  }
  const address = input.address;
  const requirements = payeeHistoryRequirements();
  const offer = {
    x402Version: 2,
    resource: {
      url: `${input.origin}${PAYEE_HISTORY_PATH}?address=${address}`,
      description: `Payee history of an Arc address across Vestiarion workspaces (${PAYEE_HISTORY_PRICE_USDC} USDC)`,
      mimeType: "application/json",
    },
    accepts: [requirements],
  };
  const paymentRequired = (error?: string): SellerAnswer => ({
    status: 402,
    headers: { ...json, "PAYMENT-REQUIRED": encodeHeader(error ? { ...offer, error } : offer) },
    body: error ? { error } : {},
  });

  if (!input.paymentHeader) return paymentRequired();
  const payload = decodeHeader<PaymentPayload>(input.paymentHeader);
  if (!payload?.payload?.authorization) return paymentRequired("The PAYMENT-SIGNATURE header is not an x402 payment.");
  // A payment for another offer — a lower price, another payee — is never verified as this one.
  if (!sameOffer(payload.accepted, requirements)) return paymentRequired("The payment accepted another offer than this one.");

  let verified: Awaited<ReturnType<Facilitator["verify"]>>;
  try {
    verified = await deps.facilitator.verify(payload, requirements);
  } catch (error) {
    console.error("x402: verify failed", error instanceof Error ? error.message : error);
    return { status: 503, headers: json, body: { error: "Circle Gateway could not verify the payment now; nothing was charged. Try again." } };
  }
  if (!verified.isValid) return paymentRequired(`The payment did not verify: ${verified.invalidReason ?? "no reason given"}.`);

  // Read before settling: a buyer is never charged for an answer it does not get.
  let history: PayeeHistory;
  try {
    history = await (deps.read ?? readPayeeHistory)(address);
  } catch (error) {
    console.error("x402: payee history not read", error instanceof Error ? error.message : error);
    return { status: 503, headers: json, body: { error: "The history could not be read now; nothing was charged. Try again." } };
  }

  let settled: Awaited<ReturnType<Facilitator["settle"]>>;
  try {
    settled = await deps.facilitator.settle(payload, requirements);
  } catch (error) {
    console.error("x402: settle failed", error instanceof Error ? error.message : error);
    return { status: 503, headers: json, body: { error: "Circle Gateway could not settle the payment now. Try again." } };
  }
  if (!settled.success) return paymentRequired(`The payment did not settle: ${settled.errorReason ?? "no reason given"}.`);

  const authorization = payload.payload.authorization;
  const sale: Sale = {
    address,
    payer: settled.payer ?? verified.payer ?? authorization.from ?? "unknown",
    nonce: authorization.nonce ?? "unknown",
    settlement: settled.transaction ?? null,
  };
  // Best effort: the buyer paid and gets its answer whatever this write does.
  try {
    await (deps.record ?? recordSale)(sale);
  } catch (error) {
    console.error("x402: sale not recorded", error instanceof Error ? error.message : error);
  }
  return {
    status: 200,
    headers: { ...json, "PAYMENT-RESPONSE": encodeHeader({ success: true, transaction: settled.transaction ?? null, network: settled.network ?? requirements.network, payer: sale.payer }) },
    body: { ...history, seller: "Vestiarion", priceUsdc: PAYEE_HISTORY_PRICE_USDC },
  };
}

export interface Sale {
  address: string;
  payer: string;
  nonce: string;
  settlement: string | null;
}

async function recordSale(sale: Sale): Promise<void> {
  const requirements = payeeHistoryRequirements();
  const inserted = await platformDb().from("x402_sales").insert({
    endpoint: PAYEE_HISTORY_PATH,
    address: sale.address,
    payer: sale.payer,
    pay_to: requirements.payTo,
    amount_usdc: PAYEE_HISTORY_PRICE_USDC,
    nonce: sale.nonce,
    settlement: sale.settlement,
  });
  if (inserted.error) throw new Error(inserted.error.message);
}
