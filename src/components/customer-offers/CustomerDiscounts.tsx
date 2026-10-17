"use client";

import { BadgePercent } from "lucide-react";
import { useState } from "react";
import { setCustomerOffersAction, type CustomerOffersActionResult } from "@/app/actions/customer-offers";
import { DocsLink } from "@/components/DocsLink";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { CustomerOffersView } from "@/lib/customer-offers/store";
import { recentDiscountLine } from "@/lib/customer-offers/words";

const INITIAL: CustomerOffersActionResult = { ok: false, message: "" };

/**
 * Bills & receivables, **Paid sooner when cash is short** (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md
 * C1): an owner or admin lets the agent offer customers a discount to pay open receivables early while bills are held for
 * cash, with the most it gives, or stops it; anyone else reads which it is. The latest offers are listed.
 */
export function CustomerDiscounts({ orgSlug, view, canWrite }: { orgSlug: string; view: CustomerOffersView; canWrite: boolean }) {
  const { state, formProps } = useActionForm(setCustomerOffersAction, INITIAL);
  const [maxPct, setMaxPct] = useState(String(view.setting.maxPct ?? 1));
  const on = view.setting.on;
  const words = view.setting.sandbox
    ? "A sandbox has no wallet to receive a payment in, so the agent offers its sample customers nothing. Turn it on in a live workspace."
    : on
      ? `While bills are held because the cash is not there, the agent offers customers up to ${(view.setting.maxPct ?? 0).toFixed(2)}% off for paying an open invoice within 5 days, by email. A customer who accepts pays the lower amount through the invoice's pay link.`
      : "While bills are held because the cash is not there, let the agent offer customers a small discount, up to the most you set, for paying an open invoice within 5 days.";
  return (
    <section aria-labelledby="paid-sooner-title" className="mb-6">
      <SectionHeader id="paid-sooner-title" title="Paid sooner when cash is short" action={<DocsLink href="/docs/guides/customer-discounts" topic="Discounts for paying early" />} />
      <Card className="divide-y divide-line">
        {canWrite && !view.setting.sandbox ? (
          <form {...formProps} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <input type="hidden" name="on" value={on ? "false" : "true"} />
            <p className="min-w-0 flex-1 basis-64 text-xs text-ink-2">{words}</p>
            {!on && (
              <label className="flex items-center gap-1 text-xs text-ink-2">
                <span>Up to</span>
                <Input name="maxPct" value={maxPct} onChange={(event) => setMaxPct(event.target.value)} inputMode="decimal" className="h-8 w-16 text-right font-mono text-xs" aria-label="The most the agent gives, in percent" />
                <span>%</span>
              </label>
            )}
            <SubmitButton size="sm" variant="secondary" pendingLabel={on ? "Turning off…" : "Turning on…"} icon={<BadgePercent aria-hidden />}>
              {on ? "Stop the agent's discounts" : "Let the agent offer discounts"}
            </SubmitButton>
            <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.message}</FormMessage>
          </form>
        ) : (
          <p className="px-4 py-3 text-xs text-ink-2 sm:px-5">{on || view.setting.sandbox ? words : "The agent offers customers no discounts. An owner or admin turns it on."}</p>
        )}
        {view.recent.length > 0 && (
          <ul aria-label="Discounts offered to customers" className="space-y-0.5 px-4 py-3 text-xs text-ink-2 sm:px-5">
            {view.recent.map((offer) => (
              <li key={offer.id}>{recentDiscountLine(offer)}</li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
