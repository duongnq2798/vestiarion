"use client";

import { Bot, HandCoins } from "lucide-react";
import { useState } from "react";
import { makeOfferAction, setAgentOffersAction, withdrawOfferAction, type OfferActionResult } from "@/app/actions/early-payment-offers";
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

type WithdrawForm = ReturnType<typeof useActionForm<OfferActionResult>>;

/**
 * One bill's offer controls. Both actions' results live in this component, which outlives the page's refresh after
 * either: the made offer's link stays on screen above the offer out, since it is never kept (E3), until the offer is
 * withdrawn, and the withdrawal says so above the form that comes back.
 */
function OfferControls({ orgSlug, candidate, reserveApy, canOffer }: { orgSlug: string; candidate: OfferCandidate; reserveApy: number; canOffer: boolean }) {
  const [link, setLink] = useState<{ url: string; message: string } | null>(null);
  const { state, formProps } = useActionForm(makeOfferAction, INITIAL, { onSuccess: (made) => setLink(made.url ? { url: made.url, message: made.message } : null) });
  const withdraw = useActionForm(withdrawOfferAction, INITIAL, { onSuccess: () => setLink(null) });
  const [pct, setPct] = useState(candidate.suggestion.pct.toFixed(2));
  const asked = Number(pct.replace(",", "."));
  const worth = offerWorth({ pct: Number.isFinite(asked) && asked > 0 ? asked : candidate.suggestion.pct, days: candidate.suggestion.days, reserveApy });
  if (link || candidate.open) {
    return (
      <div className="space-y-2">
        {link && (
          <div className="space-y-1">
            <p className="text-xs text-ink">{link.message}</p>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <code className="min-w-0 max-w-full truncate rounded-lg bg-ground px-2 py-1 font-mono text-xs text-ink-2">{link.url}</code>
              <CopyButton value={link.url} label="Copy the offer link" variant="secondary" size="sm" />
            </div>
          </div>
        )}
        {candidate.open && <OpenOffer orgSlug={orgSlug} candidate={candidate} canOffer={canOffer} withdraw={withdraw} />}
      </div>
    );
  }
  if (!canOffer) return <p className="text-xs text-ink-3">{worth} An owner or admin makes the offer.</p>;
  return (
    <div className="space-y-2">
      {withdraw.state.ok && (
        <p role="status" className="text-xs text-ink">
          {withdraw.state.message}
        </p>
      )}
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

function OpenOffer({ orgSlug, candidate, canOffer, withdraw }: { orgSlug: string; candidate: OfferCandidate; canOffer: boolean; withdraw: WithdrawForm }) {
  const open = candidate.open as NonNullable<OfferCandidate["open"]>;
  const line = (
    <p className="text-xs text-ink-2">
      Offer out: {open.pct.toFixed(2)}% off, <Money value={open.offered} token={candidate.currency} className="text-xs" /> today, until {day(open.expiresAt)}.
      {open.byAgent ? " The agent emailed it to the supplier." : null}
    </p>
  );
  if (!canOffer) return line;
  return (
    <form {...withdraw.formProps} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="offerId" value={open.id} />
      {line}
      <SubmitButton size="sm" variant="link" className="text-xs" pendingLabel="Withdrawing…">
        Withdraw
      </SubmitButton>
      <FormMessage tone="error">{withdraw.state.ok ? null : withdraw.state.message}</FormMessage>
    </form>
  );
}

/**
 * Whether the agent makes these offers itself (docs/superpowers/specs/2026-10-16-agent-early-payment-offers-design.md AO1):
 * an owner or admin turns it on with the most it asks, or off; anyone else reads which it is.
 */
function AgentOffers({ orgSlug, agent, canOffer }: { orgSlug: string; agent: NonNullable<OffersView["agent"]>; canOffer: boolean }) {
  const { state, formProps } = useActionForm(setAgentOffersAction, INITIAL);
  const [maxPct, setMaxPct] = useState((agent.maxPct ?? 2).toFixed(2));
  const on = agent.on;
  const ceiling = (agent.maxPct ?? 0).toFixed(2);
  const words = on
    ? `The agent makes these offers itself: it picks the bills and the discount, asking at most ${ceiling}%, only from cash it can pay today, and emails each supplier the link at the address payment notices go to.`
    : "Let the agent make these offers itself: it picks the bills and the discount, up to the most you set, and emails each supplier the link.";
  if (!canOffer) return <p className="px-4 py-3 text-xs text-ink-2 sm:px-5">{on ? words : "The agent does not make these offers itself. An owner or admin turns it on."}</p>;
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="on" value={on ? "false" : "true"} />
      <p className="min-w-0 flex-1 basis-64 text-xs text-ink-2">{words}</p>
      {!on && (
        <label className="flex items-center gap-1 text-xs text-ink-2">
          <span>At most</span>
          <Input name="maxPct" value={maxPct} onChange={(event) => setMaxPct(event.target.value)} inputMode="decimal" className="h-8 w-20 text-right font-mono text-xs" aria-label="The most the agent asks, in percent" />
          <span>%</span>
        </label>
      )}
      <SubmitButton size="sm" variant="secondary" pendingLabel={on ? "Turning off…" : "Turning on…"} icon={<Bot aria-hidden />}>
        {on ? "Stop the agent's offers" : "Let the agent make offers"}
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
  if (view.candidates.length === 0 && view.recent.length === 0 && !view.agent?.on) return null;
  return (
    <section aria-labelledby="early-pay-title" className="mb-6">
      <SectionHeader id="early-pay-title" title="Pay early for a discount" action={<DocsLink href="/docs/guides/early-payment-offers" topic="Early-payment offers" />} />
      <Card className="divide-y divide-line">
        <p className="px-4 py-3 text-sm text-ink-2 sm:px-5">
          These bills are paid later. A supplier who would rather be paid today may take a little less for it: offer them a discount, and if they accept,
          the agent pays the discounted amount at once.
        </p>
        {view.agent && <AgentOffers orgSlug={orgSlug} agent={view.agent} canOffer={canOffer} />}
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
