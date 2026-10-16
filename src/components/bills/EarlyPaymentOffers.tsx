"use client";

import { HandCoins } from "lucide-react";
import { useState } from "react";
import { makeOfferAction, withdrawOfferAction, type OfferActionResult } from "@/app/actions/early-payment-offers";
import { DocsLink } from "@/components/DocsLink";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { Money } from "@/components/vx/Primitives";
import { offerWorth, type OfferCandidate, type OffersView } from "@/lib/early-pay/offers-words";

const INITIAL: OfferActionResult = { ok: false, message: "" };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * One bill's offer controls. The made offer's link lives in this component's state, which outlives the page's refresh
 * after the action: the bill then has an open offer, and the link must stay on screen, since it is never kept (E3).
 */
function OfferControls({ orgSlug, candidate, reserveApy, canOffer }: { orgSlug: string; candidate: OfferCandidate; reserveApy: number; canOffer: boolean }) {
  const { state, formProps } = useActionForm(makeOfferAction, INITIAL);
  const [pct, setPct] = useState(candidate.suggestion.pct.toFixed(2));
  const asked = Number(pct.replace(",", "."));
  const worth = offerWorth({ pct: Number.isFinite(asked) && asked > 0 ? asked : candidate.suggestion.pct, days: candidate.suggestion.days, reserveApy });
  if (state.ok && state.url) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-ink">{state.message}</p>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <code className="min-w-0 max-w-full truncate rounded-lg bg-ground px-2 py-1 font-mono text-xs text-ink-2">{state.url}</code>
          <CopyButton value={state.url} label="Copy the offer link" variant="secondary" size="sm" />
        </div>
      </div>
    );
  }
  if (candidate.open) return <OpenOffer orgSlug={orgSlug} candidate={candidate} />;
  if (!canOffer) return <p className="text-xs text-ink-3">{worth} An owner or admin makes the offer.</p>;
  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-2">{worth}</p>
      <form {...formProps} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="invoiceId" value={candidate.invoiceId} />
        <label className="flex items-center gap-1 text-xs text-ink-2">
          <span className="sr-only">Discount asked, in percent</span>
          <Input
            name="pct"
            value={pct}
            onChange={(event) => setPct(event.target.value)}
            inputMode="decimal"
            className="h-8 w-20 text-right font-mono text-xs"
            aria-label={`Discount asked from ${candidate.counterpartyName}, in percent`}
          />
          <span>%</span>
        </label>
        <SubmitButton size="sm" variant="secondary" pendingLabel="Making the offer…" icon={<HandCoins aria-hidden />}>
          Offer this discount for paying today
        </SubmitButton>
        <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
      </form>
    </div>
  );
}

function OpenOffer({ orgSlug, candidate }: { orgSlug: string; candidate: OfferCandidate }) {
  const { state, formProps } = useActionForm(withdrawOfferAction, INITIAL);
  const open = candidate.open as NonNullable<OfferCandidate["open"]>;
  return (
    <form {...formProps} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="offerId" value={open.id} />
      <p className="text-xs text-ink-2">
        Offer out: {open.pct.toFixed(2)}% off, <Money value={open.offered} token={candidate.currency} className="text-xs" /> today, until {day(open.expiresAt)}.
      </p>
      <SubmitButton size="sm" variant="link" className="text-xs" pendingLabel="Withdrawing…">
        Withdraw
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.message}</FormMessage>
    </form>
  );
}

/**
 * Bills & receivables, **Pay early for a discount** (docs/superpowers/specs/2026-10-16-early-payment-offers-design.md
 * E1-E3, E8): the bills the agent will pay later, each with the discount worth asking for paying today instead, which an
 * owner or admin offers the supplier through a one-time link. An accepted offer puts the discount on the bill, and the
 * agent pays it at once, after every check.
 */
export function EarlyPaymentOffers({ orgSlug, view, canOffer }: { orgSlug: string; view: OffersView; canOffer: boolean }) {
  if (view.candidates.length === 0 && view.recent.length === 0) return null;
  return (
    <section aria-labelledby="early-pay-title" className="mb-6">
      <SectionHeader id="early-pay-title" title="Pay early for a discount" action={<DocsLink href="/docs/guides/early-payment-offers" topic="Early-payment offers" />} />
      <Card className="divide-y divide-line">
        <p className="px-4 py-3 text-sm text-ink-2 sm:px-5">
          These bills are paid later. A supplier who would rather be paid today may take a little less for it: offer them a discount, and if they accept,
          the agent pays the discounted amount at once.
        </p>
        {view.candidates.map((candidate) => (
          <div key={candidate.invoiceId} className="grid gap-2 px-4 py-3 sm:px-5 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-start">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{candidate.counterpartyName}</p>
              <p className="truncate text-xs text-ink-3">
                {candidate.reference ?? "No reference"} · due {day(candidate.dueDate)}
              </p>
              <Money value={candidate.amount} token={candidate.currency} className="text-sm font-semibold text-ink" />
            </div>
            <div className="min-w-0">
              <OfferControls orgSlug={orgSlug} candidate={candidate} reserveApy={view.reserveApy} canOffer={canOffer} />
            </div>
          </div>
        ))}
        {view.recent.length > 0 && (
          <ul aria-label="Offers decided" className="space-y-0.5 px-4 py-3 text-xs text-ink-2 sm:px-5">
            {view.recent.map((offer) => (
              <li key={offer.id}>
                {offer.counterpartyName} {offer.status === "accepted" ? "accepted" : offer.status === "declined" ? "declined" : "was withdrawn"} {offer.pct.toFixed(2)}% off, {day(offer.decidedAt)}.
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
