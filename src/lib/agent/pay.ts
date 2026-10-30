import { db } from "../dal";
import { getChainProvider, type ChainProvider, type Stablecoin } from "../circle";
import type { BankPayoutParams, PayoutRoute, SpendingLimitPayment } from "../circle/types";
import { executePayment, executePaymentBatch, type PaymentExecution, type PaymentRequest, paymentMemo, SupabasePaymentIntentStore } from "../payments";
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

  // The owner's own wallet keeps no gas and no reserve aside: its agent pays the gas (wallet treasury W12).
  const external = provider.treasury === "external";
  let carveOut = 0;
  if (!external && provider.mode === "live" && provider.earnMode === "simulate") {
    const reserve = (
      await client.from("accounts").select("balance").eq("kind", "reserve").maybeSingle()
    ).data as { balance: string } | null;
    carveOut = num(reserve?.balance);
  }

  // An EOA keeps USDC for its own gas (mainnet go-live M6); 0 where gas is sponsored.
  const spendable = Math.max(0, Number((snapshot.balance - carveOut - (external ? 0 : provider.network.gasReserveUsdc)).toFixed(6)));
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
  /** The payee's chain: another than Arc testnet is paid through CCTP, in flight until the mint (CCTP payouts X2, X8). */
  destinationChain?: string;
  /** The most the CCTP fee may be, in USDC; a higher fee read at the burn sends nothing (review I4). */
  maxBridgeFeeUsdc?: number;
  /** How a payment across chains goes, for its first attempt: the intent keeps it after (Gateway payouts G2). */
  route?: PayoutRoute;
  /** The agent's payment while its spending limit is enforced on Arc: sent through the contract (onchain spending limit R3). Never a person's. */
  spendingLimit?: SpendingLimitPayment;
  /** A vendor's bill paid to its bank account through BlindPay (bank payouts B7): the address is not used. */
  bank?: BankPayoutParams;
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
  if (!operating) return noOperatingAccount(input);
  const { request, amountPaid, discountTaken } = invoicePaymentRequest(input, operating.id);

  let result;
  try {
    result = await executePayment(request, { provider, retryTerminalFailure });
  } catch (err) {
    return executionFailed(err, { amountPaid, discountTaken });
  }

  const paid = invoicePaymentResult(result, { amountPaid, discountTaken });
  // A EURC payment leaves the stored balance, which is USDC, as it is.
  if (result.status !== "confirmed" || (input.currency ?? "USDC") !== "USDC") return paid;
  return { ...paid, ...(await balanceAfterPayment(operating.id)) };
}

/**
 * `payInvoice` for several invoices at once (docs/superpowers/specs/2026-10-30-approve-many-design.md AM6): each gets
 * exactly the request `payInvoice` builds for it, the discount taken as of now. Where they can share one Arc transaction
 * (two or more, a provider that batches, a network whose wallets are smart accounts) they go to `executePaymentBatch`
 * together, so those that may be batched are (batch payouts R1-R4) and the rest go alone, as R1 says. Otherwise each
 * goes alone through `executePayment`, as the contractor stage releases milestones on such a network. Each execution
 * maps to the result `payInvoice` returns for it, in the inputs' order, with one balance sync after if any USDC payment
 * was confirmed. A throw is mapped as `payInvoice` maps a thrown transfer, held with nothing known to have moved, for
 * the invoices it leaves without a transfer only: never for one already sent (approve many review money-1).
 *
 * Unlike `payInvoice` it never sends a terminally failed payment again (`retryTerminalFailure`): it pays bills never sent.
 */
export async function payInvoices(
  inputs: PayInvoiceInput[],
  deps: { provider: ChainProvider; operating: { id: string } | null }
): Promise<PayInvoiceResult[]> {
  const { provider, operating } = deps;
  if (!operating) return inputs.map(noOperatingAccount);
  const built = inputs.map((input) => invoicePaymentRequest(input, operating.id));
  const requests = built.map(({ request }) => request);

  // A batch needs a smart account (mainnet go-live M6), as `releaseMilestones` reads it: on a network whose wallets are
  // EOAs `executePaymentBatch` would send them one after another with no catch between them, so one bill's throw would
  // hide the transfers made before it. Each goes alone here instead, with its own catch, as `payInvoice` sends it.
  const together = requests.length >= 2 && provider.batchTransfer !== undefined && provider.network.walletAccountType === "SCA";
  const sent = together ? await sentTogether(requests, provider) : await sentAlone(requests, provider);

  const results = sent.map((outcome, index) => ("execution" in outcome ? invoicePaymentResult(outcome.execution, built[index]) : executionFailed(outcome.thrown, built[index])));
  const confirmed = (index: number) => {
    const outcome = sent[index];
    return "execution" in outcome && outcome.execution.status === "confirmed" && (inputs[index].currency ?? "USDC") === "USDC";
  };
  if (!results.some((_, index) => confirmed(index))) return results;
  // One sync for every confirmed payment, as the contractor stage syncs once after a batch of releases.
  const after = await balanceAfterPayment(operating.id);
  return results.map((result, index) => (confirmed(index) ? { ...result, ...after } : result));
}

/** What one invoice's send came to: its execution, or what it threw before any result. */
type Sent = { execution: PaymentExecution } | { thrown: unknown };

/** Each request alone, in order, under its own key: a throw is that request's own, as `payInvoice` catches it. */
async function sentAlone(requests: PaymentRequest[], provider: ChainProvider): Promise<Sent[]> {
  const sent: Sent[] = [];
  for (const request of requests) {
    try {
      sent.push({ execution: await executePayment(request, { provider }) });
    } catch (thrown) {
      sent.push({ thrown });
    }
  }
  return sent;
}

/**
 * The requests through one `executePaymentBatch` call. A throw from it says nothing of what it sent before it threw, so
 * each source's intent is read again: one Circle took (it has Circle's id) or confirmed goes through `executePayment`,
 * which only reads a transfer that exists and never sends it again, and is recorded as this approval's own send. The
 * rest are held, nothing known to have moved for them.
 */
async function sentTogether(requests: PaymentRequest[], provider: ChainProvider): Promise<Sent[]> {
  try {
    return (await executePaymentBatch(requests, { provider })).map((execution) => ({ execution }));
  } catch (thrown) {
    const store = new SupabasePaymentIntentStore();
    const sent: Sent[] = [];
    for (const request of requests) {
      try {
        const intent = await store.findBySource(request.sourceType, request.sourceId);
        if (intent && (intent.providerTxId || intent.status === "confirmed")) {
          sent.push({ execution: { ...(await executePayment(request, { provider, store })), reconciled: false } });
          continue;
        }
      } catch {
        // Not read either: nothing is known of this one, as of the others.
      }
      sent.push({ thrown });
    }
    return sent;
  }
}

/**
 * The transfer for one invoice, as the AP stage has always sent it: `amountToPay` of it, to its payout address (or its
 * bank account), with its memo, token, chain, route and contract. Decided at the moment of payment, not when the
 * invoice was scheduled: a transfer made the day after the discount deadline is the full amount.
 */
function invoicePaymentRequest(input: PayInvoiceInput, operatingAccountId: string): { request: PaymentRequest; amountPaid: number; discountTaken: number } {
  const { amountPaid, discountTaken } = amountToPay(input.amount, input.discount ?? null, new Date());
  const request: PaymentRequest = {
    sourceType: "invoice",
    sourceId: input.invoiceId,
    fromAccountId: operatingAccountId,
    // A bank payout's intent names the bank account it went to, not an address (bank payouts B7).
    destination: input.bank ? `blindpay:${input.bank.bankAccountId}` : payoutAddress(input.address, input.counterpartyId),
    amount: amountPaid,
    memo: paymentMemo("invoice", input.invoiceId),
    token: input.currency ?? "USDC",
    ...(input.destinationChain ? { destinationChain: input.destinationChain } : {}),
    ...(input.maxBridgeFeeUsdc != null ? { maxBridgeFeeUsdc: input.maxBridgeFeeUsdc } : {}),
    ...(input.route ? { route: input.route } : {}),
    ...(input.spendingLimit ? { spendingLimit: input.spendingLimit } : {}),
    ...(input.bank ? { bank: input.bank } : {}),
  };
  return { request, amountPaid, discountTaken };
}

/** No operating account holds the invoice without ever calling the provider. */
function noOperatingAccount(input: PayInvoiceInput): PayInvoiceResult {
  const { amountPaid, discountTaken } = amountToPay(input.amount, input.discount ?? null, new Date());
  return { status: "held", txRef: null, execution: null, note: " [no operating account configured]", operatingBalance: null, amountPaid, discountTaken };
}

/** Nothing is known to have moved: no transfer result exists at all. */
function executionFailed(err: unknown, amounts: { amountPaid: number; discountTaken: number }): PayInvoiceResult {
  return { status: "held", txRef: null, execution: null, note: ` [execution failed: ${(err as Error).message}]`, operatingBalance: null, ...amounts };
}

/** A transfer's outcome as the invoice records it, before any balance sync: confirmed is paid, pending is matched. */
function invoicePaymentResult(result: PaymentExecution, amounts: { amountPaid: number; discountTaken: number }): PayInvoiceResult {
  const status = result.status === "confirmed" ? "paid" : result.status === "pending" ? "matched" : "held";
  let note = "";
  if (result.status === "failed") {
    note = ` [transfer failed: ${result.error ?? "provider reported failure"}]`;
  } else if (result.status === "pending") {
    // A send Circle never answered is pending too, with what the lookup said (payment safety R4).
    note = result.error ? ` [${result.error}]` : " [transfer submitted; awaiting provider confirmation]";
  }
  return { status, txRef: result.txRef, execution: result, note, operatingBalance: null, amountPaid: amounts.amountPaid, discountTaken: amounts.discountTaken };
}

/**
 * The stored balance after a confirmed USDC payment. The transfer is already confirmed: status, txRef and execution are
 * real regardless of what happens next. A sync failure here must not demote a confirmed payment back to "held": that
 * would understate money that actually moved, and the agent would never look at this invoice again.
 */
async function balanceAfterPayment(operatingAccountId: string): Promise<{ operatingBalance: number | null; note: string }> {
  try {
    return { operatingBalance: await syncOperatingBalance(operatingAccountId), note: "" };
  } catch (err) {
    return { operatingBalance: null, note: ` [balance sync failed: ${(err as Error).message}]` };
  }
}
