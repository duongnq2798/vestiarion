"use client";

import { ArrowRight, Check, X } from "lucide-react";
import { decideDiscountAction, type DiscountDecisionResult } from "@/app/discount/[token]/actions";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { discountLine } from "@/lib/customer-offers/words";

const INITIAL: DiscountDecisionResult = { ok: false, message: "" };

export interface DiscountShown {
  orgName: string;
  customerName: string;
  reference: string | null;
  amount: number;
  discounted: number;
  currency: string;
  pct: number;
  dueDate: string;
  payBy: string;
}

/**
 * The customer's page of an early-payment discount (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md
 * C4): who offers, for which invoice, what they pay by when instead of the full amount on the due date, and Accept or No
 * thanks. One answer; accepted, the page sends them to the invoice's pay link.
 */
export function DiscountDecision({ token, offer }: { token: string; offer: DiscountShown }) {
  const { state, formProps } = useActionForm(decideDiscountAction, INITIAL);
  return (
    <Card className="space-y-5 p-6">
      <div className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-wide text-ink-3">Early payment</p>
        <h1 className="text-xl font-semibold text-ink [text-wrap:balance]">{discountLine(offer)}</h1>
        <p className="text-sm text-ink-2">
          Accept it and the invoice&apos;s amount is {offer.pct.toFixed(2)}% lower until the end of that day (UTC). You pay it as you would anyway, through the invoice&apos;s pay
          link, to the same address. Keep the due date instead, and nothing changes.
        </p>
      </div>
      {state.ok ? (
        <div className="space-y-3">
          <p role="status" className="text-sm text-ink">
            {state.message}
          </p>
          {state.outcome === "accepted" && state.payUrl ? (
            <a href={state.payUrl} className="inline-flex items-center gap-1.5 text-sm font-medium text-agent underline-offset-4 hover:underline">
              Open the pay link <ArrowRight className="size-4" aria-hidden />
            </a>
          ) : null}
        </div>
      ) : (
        <form {...formProps} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="token" value={token} />
          <SubmitButton name="decision" value="accept" pendingLabel="Accepting…" icon={<Check aria-hidden />}>
            Accept: pay less by paying early
          </SubmitButton>
          <SubmitButton name="decision" value="decline" variant="secondary" pendingLabel="Answering…" icon={<X aria-hidden />}>
            No thanks
          </SubmitButton>
          <FormMessage tone={state.message ? "error" : "neutral"}>{state.message}</FormMessage>
        </form>
      )}
    </Card>
  );
}
