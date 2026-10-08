"use client";

import { ArrowUpRight, Check, Clock } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import type { ActionResult } from "@/components/ui/useActionForm";
import { Money } from "@/components/vx/Primitives";
import type { PaymentReceipt } from "@/lib/payment-receipt";

/**
 * A person's payment, told where they made it in steps that never run ahead of the money (payment confirmation):
 * "Payment approved" while it is sent, then "Payment confirmed" once the network confirms it, or "Payment processing"
 * while it still confirms. Each reads in the order a person asks: has it gone, how much, to whom, who decided it, on
 * which network, and where to check it. The transaction is a quiet link, so it never outshines the payment itself.
 */

type Sending = Pick<PaymentReceipt, "amount" | "currency" | "payee" | "decidedBy">;

/** The id a payment's notices share, so its confirmation replaces the notice raised while it was being sent. */
export function paymentToastId(key: string): string {
  return `payment-${key}`;
}

const DECIDED: Record<PaymentReceipt["decidedBy"], string> = {
  approval: "Approved by you",
  verdict: "Agent decision approved by you",
};

/** Long enough to read and to reach the transaction; hovering keeps it, and its close button ends it. */
const SHOWN_MS: Record<PaymentReceipt["state"], number> = { confirmed: 10_000, confirming: 15_000 };

/** While the action runs: approved, and being sent. It stays until the payment's confirmation replaces it, or nothing was paid. */
export function paymentSendingToast(id: string, sending: Sending): void {
  toast.loading("Payment approved", {
    id,
    description: <PaymentToastBody amount={sending.amount} currency={sending.currency} toLine={`Sending to ${sending.payee}`} decidedBy={sending.decidedBy} />,
  });
}

/** The payment's confirmation, in place of its sending notice when `id` names one. */
export function paymentReceiptToast(receipt: PaymentReceipt, id?: string): void {
  const confirmed = receipt.state === "confirmed";
  const options = {
    ...(id ? { id } : {}),
    description: (
      <PaymentToastBody
        amount={receipt.amount}
        currency={receipt.currency}
        toLine={confirmed ? `Paid to ${receipt.payee}` : `Sent to ${receipt.payee}`}
        decidedBy={receipt.decidedBy}
        fromReserve={receipt.fromReserve}
        network={confirmed ? receipt.network : `Waiting for ${receipt.network} to confirm it`}
        txUrl={receipt.txUrl}
      />
    ),
    duration: SHOWN_MS[receipt.state],
    closeButton: true,
    // Room for the close button beside the title.
    classNames: { title: "pr-7" },
  };
  if (confirmed) toast.success("Payment confirmed", options);
  else toast.info("Payment processing", { ...options, icon: <Clock className="size-[1.125rem] text-held" /> });
}

/**
 * After a payment's action: its confirmation in place of the sending notice, or the notice taken away when nothing was
 * paid (`result` null when the action failed outright). True when a confirmation was raised.
 */
export function settlePaymentToast(id: string, result: { ok: boolean; receipt?: PaymentReceipt } | null): boolean {
  if (result?.ok && result.receipt) {
    paymentReceiptToast(result.receipt, id);
    return true;
  }
  toast.dismiss(id);
  return false;
}

/**
 * Approve and pay's form action, which raises the payment's confirmation itself, as `withSuccessToast` does: the card
 * that paid leaves the page in the refresh that delivers the result. Its sending notice, raised as the person confirms,
 * is the form's `invoiceId`'s; anything else the action says is the plain success toast.
 */
export function withPaymentReceipt<State extends ActionResult>(action: (previous: State, formData: FormData) => Promise<State>) {
  return async (previous: State, formData: FormData): Promise<State> => {
    const id = paymentToastId(String(formData.get("invoiceId") ?? ""));
    let result: State;
    try {
      result = await action(previous, formData);
    } catch (error) {
      settlePaymentToast(id, null);
      throw error;
    }
    if (!settlePaymentToast(id, result as State & { receipt?: PaymentReceipt }) && result.ok && result.message) toast.success(result.message);
    return result;
  };
}

function PaymentToastBody({
  amount,
  currency,
  toLine,
  decidedBy,
  fromReserve = null,
  network = null,
  txUrl = null,
}: {
  amount: number;
  currency: string;
  toLine: string;
  decidedBy: PaymentReceipt["decidedBy"];
  fromReserve?: string | null;
  network?: string | null;
  txUrl?: string | null;
}) {
  return (
    <span className="mt-1.5 grid gap-1">
      <Money value={amount} token={currency} className="text-2xl leading-8 font-semibold text-ink" />
      <span className="text-sm text-ink-2">{toLine}</span>
      <span className="mt-1 flex items-center gap-1.5 text-xs text-ink-2">
        <Check aria-hidden className="size-3.5 shrink-0 text-proof" />
        {DECIDED[decidedBy]}
      </span>
      {fromReserve && <span className="text-xs text-ink-3">{fromReserve}</span>}
      {(network || txUrl) && (
        <span className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-ink-3">
          {network && <span>{network}</span>}
          {txUrl && (
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 font-medium text-agent underline-offset-2 hover:underline"
            >
              View transaction
              <ArrowUpRight aria-hidden className="size-3.5" />
            </a>
          )}
        </span>
      )}
    </span>
  );
}
