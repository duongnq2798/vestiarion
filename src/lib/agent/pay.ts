import { db } from "../dal";
import { getChainProvider, type ChainProvider, type Stablecoin } from "../circle";
import { executePayment, type PaymentExecution } from "../payments";
import { amountToPay, type InvoiceDiscount } from "./payment-timing";

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

/**
 * Writes the operating account's balance back from whatever the provider
 * considers the chain. In simulate mode the provider already decremented it;
 * in live mode this is the only thing that keeps the stored balance in step
 * with Arc after a transfer. Without it, the treasury step later in the same
 * cycle reasons about money that has already left the wallet.
 *
 * The notional USYC carve-out is applied here for the same reason it is
 * applied during reconciliation — see the comment there.
 */
export async function syncOperatingBalance(accountId: string): Promise<number> {
  const client = db();
  const provider = getChainProvider();
  const snapshot = await provider.getBalance(accountId);

  let carveOut = 0;
  if (provider.mode === "live" && provider.earnMode === "simulate") {
    const reserve = (
      await client.from("accounts").select("balance").eq("kind", "reserve").maybeSingle()
    ).data as { balance: string } | null;
    carveOut = num(reserve?.balance);
  }

  const spendable = Math.max(0, Number((snapshot.balance - carveOut).toFixed(6)));
  const res = await client.from("accounts").update({ balance: spendable }).eq("id", accountId);
  if (res.error) throw new Error(res.error.message);
  return spendable;
}

/** Where a payment should actually land, or null when the counterparty has no wallet yet. */
export function payoutAddress(address: string | null, counterpartyId: string): string {
  return address ?? `sim:${counterpartyId}`;
}

export interface PayInvoiceInput {
  invoiceId: string;
  counterpartyId: string;
  address: string | null;
  /** The invoice's full amount: what any limit or funds check is made against. */
  amount: number;
  /** Lowers the transfer through the end of the deadline's UTC day, never after it (spec 2026-09-30-payment-timing P5). */
  discount?: InvoiceDiscount | null;
  /** The invoice's currency, which the transfer moves: an EURC invoice is paid in EURC, never in USDC (EURC invoices design E5). */
  currency?: Stablecoin;
}

export interface PayInvoiceResult {
  status: "paid" | "matched" | "held";
  txRef: string | null;
  execution: PaymentExecution | null;
  /** Appended to the invoice's reasoning, exactly as the AP stage wrote it before. */
  note: string;
  /** The operating balance after a confirmed payment, else null. */
  operatingBalance: number | null;
  /**
   * What this payment's transfer carries: the discounted amount through the
   * discount deadline's UTC day, the full amount otherwise. Whether it moved
   * is `status`.
   */
  amountPaid: number;
  /** `amount` less `amountPaid`: 0 without a discount, or once its deadline has passed. */
  discountTaken: number;
}

/**
 * The one payment step for a payable invoice — moved out of the AP stage so
 * a person paying a held payable takes exactly the same step the agent does.
 * Behaviour is unchanged from what the AP stage did inline: no operating
 * account holds the invoice without ever calling the provider; otherwise the
 * transfer's outcome (confirmed, pending, failed, or thrown) maps to the same
 * status and the same note text as before.
 *
 * The transfer is `amountToPay` (./payment-timing.ts) of the invoice: the
 * early-payment discount comes off through the end of its deadline's UTC
 * day, the same rule for the agent and for a person's approval.
 *
 * `retryTerminalFailure` is `executePayment`'s: only a person's Approve and
 * pay sets it, so that a payment Circle ended in a terminal failure is sent
 * again under a new attempt's key. The agent's cycle leaves it unset and a
 * failed transfer stays held for a person.
 */
export async function payInvoice(
  input: PayInvoiceInput,
  deps: { provider: ChainProvider; operating: { id: string } | null; retryTerminalFailure?: boolean }
): Promise<PayInvoiceResult> {
  const { provider, operating, retryTerminalFailure = false } = deps;
  // Decided at the moment of payment, not when the invoice was scheduled: a
  // transfer made the day after the discount deadline is the full amount.
  const { amountPaid, discountTaken } = amountToPay(input.amount, input.discount ?? null, new Date());

  if (!operating) {
    return {
      status: "held",
      txRef: null,
      execution: null,
      note: " [no operating account configured]",
      operatingBalance: null,
      amountPaid,
      discountTaken,
    };
  }

  let result;
  try {
    result = await executePayment(
      {
        sourceType: "invoice",
        sourceId: input.invoiceId,
        fromAccountId: operating.id,
        destination: payoutAddress(input.address, input.counterpartyId),
        amount: amountPaid,
        memo: `Invoice ${input.invoiceId}`,
        token: input.currency ?? "USDC",
      },
      { provider, retryTerminalFailure }
    );
  } catch (err) {
    // Nothing is known to have moved: no transfer result exists at all.
    return {
      status: "held",
      txRef: null,
      execution: null,
      note: ` [execution failed: ${(err as Error).message}]`,
      operatingBalance: null,
      amountPaid,
      discountTaken,
    };
  }

  const status = result.status === "confirmed" ? "paid" : result.status === "pending" ? "matched" : "held";
  let note = "";
  let operatingBalance: number | null = null;
  if (result.status === "failed") {
    note = ` [transfer failed: ${result.error ?? "provider reported failure"}]`;
  } else if (result.status === "pending") {
    note = " [transfer submitted; awaiting provider confirmation]";
  } else if ((input.currency ?? "USDC") === "USDC") {
    // The transfer is already confirmed — status, txRef and execution below
    // are real regardless of what happens next. A sync failure here must not
    // demote a confirmed payment back to "held": that would understate money
    // that actually moved, and the agent would never look at this invoice
    // again. A EURC payment leaves the stored balance, which is USDC, as it is.
    try {
      operatingBalance = await syncOperatingBalance(operating.id);
    } catch (err) {
      note = ` [balance sync failed: ${(err as Error).message}]`;
    }
  }

  return { status, txRef: result.txRef, execution: result, note, operatingBalance, amountPaid, discountTaken };
}
