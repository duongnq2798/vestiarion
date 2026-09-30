import { db } from "../dal";
import { getChainProvider, type ChainProvider } from "../circle";
import { executePayment, type PaymentExecution } from "../payments";

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
  amount: number;
}

export interface PayInvoiceResult {
  status: "paid" | "matched" | "held";
  txRef: string | null;
  execution: PaymentExecution | null;
  /** Appended to the invoice's reasoning, exactly as the AP stage wrote it before. */
  note: string;
  /** The operating balance after a confirmed payment, else null. */
  operatingBalance: number | null;
}

/**
 * The one payment step for a payable invoice — moved out of the AP stage so
 * a person paying a held payable takes exactly the same step the agent does.
 * Behaviour is unchanged from what the AP stage did inline: no operating
 * account holds the invoice without ever calling the provider; otherwise the
 * transfer's outcome (confirmed, pending, failed, or thrown) maps to the same
 * status and the same note text as before.
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

  if (!operating) {
    return {
      status: "held",
      txRef: null,
      execution: null,
      note: " [no operating account configured]",
      operatingBalance: null,
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
        amount: input.amount,
        memo: `Invoice ${input.invoiceId}`,
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
    };
  }

  const status = result.status === "confirmed" ? "paid" : result.status === "pending" ? "matched" : "held";
  let note = "";
  let operatingBalance: number | null = null;
  if (result.status === "failed") {
    note = ` [transfer failed: ${result.error ?? "provider reported failure"}]`;
  } else if (result.status === "pending") {
    note = " [transfer submitted; awaiting provider confirmation]";
  } else {
    // The transfer is already confirmed — status, txRef and execution below
    // are real regardless of what happens next. A sync failure here must not
    // demote a confirmed payment back to "held": that would understate money
    // that actually moved, and the agent would never look at this invoice
    // again.
    try {
      operatingBalance = await syncOperatingBalance(operating.id);
    } catch (err) {
      note = ` [balance sync failed: ${(err as Error).message}]`;
    }
  }

  return { status, txRef: result.txRef, execution: result, note, operatingBalance };
}
