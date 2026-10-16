"use client";

import { Check, X } from "lucide-react";
import { decideOfferAction, type OfferDecisionResult } from "@/app/offer/[token]/actions";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { offerLine } from "@/lib/early-pay/offers-words";

const INITIAL: OfferDecisionResult = { ok: false, message: "" };

export interface OfferShown {
  orgName: string;
  counterpartyName: string;
  reference: string | null;
  amount: number;
  offered: number;
  currency: string;
  pct: number;
  dueDate: string;
  expiresAt: string;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * The supplier's page of an early-payment offer (docs/superpowers/specs/2026-10-16-early-payment-offers-design.md E4):
 * who offers, for which invoice, what they receive today instead of on the due date, and Accept or Decline. One answer,
 * then the page says what happens next.
 */
export function OfferDecision({ token, offer }: { token: string; offer: OfferShown }) {
  const { state, formProps } = useActionForm(decideOfferAction, INITIAL);
  return (
    <Card className="space-y-5 p-6">
      <div className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-wide text-ink-3">Early payment</p>
        <h1 className="text-xl font-semibold text-ink [text-wrap:balance]">
          {offerLine({ orgName: offer.orgName, reference: offer.reference, amount: offer.amount, offered: offer.offered, currency: offer.currency, dueDate: offer.dueDate })}
        </h1>
        <p className="text-sm text-ink-2">
          That is {offer.pct.toFixed(2)}% less, paid today instead of waiting for the due date. It goes where {offer.orgName} already pays {offer.counterpartyName}. The offer
          stands until {day(offer.expiresAt)}.
        </p>
      </div>
      {state.ok ? (
        <p role="status" className="text-sm text-ink">
          {state.message}
        </p>
      ) : (
        <form {...formProps} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="token" value={token} />
          <SubmitButton name="decision" value="accept" pendingLabel="Accepting…" icon={<Check aria-hidden />}>
            Accept: get paid today
          </SubmitButton>
          <SubmitButton name="decision" value="decline" variant="secondary" pendingLabel="Declining…" icon={<X aria-hidden />}>
            Decline
          </SubmitButton>
          <FormMessage tone={state.message ? "error" : "neutral"}>{state.message}</FormMessage>
        </form>
      )}
    </Card>
  );
}
