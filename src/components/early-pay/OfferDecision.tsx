"use client";

import { Check, MessageSquareReply, X } from "lucide-react";
import { useState } from "react";
import { counterOfferAction, decideOfferAction, type OfferDecisionResult } from "@/app/offer/[token]/actions";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
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

/** Half the offered discount, down to the nearest 0.25%, as the counter's starting value; never below 0.1%. */
const halfOf = (pct: number) => Math.max(0.1, Math.floor((pct / 2) * 4) / 4);

/**
 * The supplier's page of an early-payment offer (docs/superpowers/specs/2026-10-16-early-payment-offers-design.md E4):
 * who offers, for which invoice, what they receive today instead of on the due date, and Accept or Decline. On an offer
 * the agent made, the supplier may also propose a smaller discount, which the agent answers by email
 * (docs/superpowers/specs/2026-10-17-offer-counters-design.md N1). One answer, then the page says what happens next.
 */
export function OfferDecision({ token, offer, canCounter = false }: { token: string; offer: OfferShown; canCounter?: boolean }) {
  const { state, formProps } = useActionForm(decideOfferAction, INITIAL);
  const counter = useActionForm(counterOfferAction, INITIAL);
  const [pct, setPct] = useState(halfOf(offer.pct).toFixed(2));
  const answered = state.ok ? state : counter.state.ok ? counter.state : null;
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
      {answered ? (
        <p role="status" className="text-sm text-ink">
          {answered.message}
        </p>
      ) : (
        <div className="space-y-4">
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
          {canCounter && (
            <form {...counter.formProps} className="space-y-2 border-t border-line pt-4">
              <input type="hidden" name="token" value={token} />
              <p className="text-sm text-ink-2">Would a smaller discount work for you? Propose one, and {offer.orgName} answers you by email.</p>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-sm text-ink-2">
                  <Input
                    name="pct"
                    value={pct}
                    onChange={(event) => setPct(event.target.value)}
                    inputMode="decimal"
                    className="h-9 w-24 text-right font-mono text-sm"
                    aria-label={`The discount you propose instead of ${offer.pct.toFixed(2)}%, in percent`}
                  />
                  <span>%</span>
                </label>
                <SubmitButton variant="secondary" pendingLabel="Sending…" icon={<MessageSquareReply aria-hidden />}>
                  Propose a smaller discount
                </SubmitButton>
              </div>
              <FormMessage tone={counter.state.message ? "error" : "neutral"}>{counter.state.message}</FormMessage>
            </form>
          )}
        </div>
      )}
    </Card>
  );
}
