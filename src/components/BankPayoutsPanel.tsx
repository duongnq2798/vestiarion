"use client";

import { Landmark } from "lucide-react";
import { useEffect } from "react";
import { startBankPayoutsAction, type BankPayoutsActionResult } from "@/app/actions/bank-payouts";
import { DocsLink } from "@/components/DocsLink";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: BankPayoutsActionResult = { ok: false, message: "" };

/** What the card shows (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B3). */
export type BankPayoutsView =
  | { state: "not_set_up" }
  | { state: "not_started" }
  | { state: "set_up"; kybStatus: string | null; setUpAt: string | null; vendors: number };

/** What BlindPay's way back says, by the code it carries in `?bankpayouts=`. */
export const BANK_PAYOUTS_NOTICES: Record<string, { tone: "success" | "error"; text: string }> = {
  set_up: { tone: "success", text: "Bank payouts are set up. Add a vendor's bank account on Counterparties to pay it in pesos." },
  failed: { tone: "error", text: "BlindPay did not finish setting the workspace up. Try again in a moment." },
  forbidden: { tone: "error", text: "Only an owner sets up bank payouts." },
  no_terms: { tone: "error", text: "BlindPay did not send back the accepted terms, so nothing changed. Start again." },
};

const KYB_WORDS: Record<string, string> = {
  approved: "Approved by BlindPay",
  verifying: "BlindPay is checking the business",
  pending_review: "BlindPay is reviewing the business",
  rejected: "BlindPay did not approve the business",
};

function Start({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(startBankPayoutsAction, INITIAL);
  // BlindPay's terms open on its own page, which sends the owner back here to finish (B3).
  useEffect(() => {
    if (state.ok && state.url) window.location.assign(state.url);
  }, [state]);
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton size="sm" pendingLabel="Opening BlindPay…" icon={<Landmark aria-hidden />}>
        Accept BlindPay&apos;s terms and set up
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.message}</FormMessage>
    </form>
  );
}

/**
 * Settings, **Bank payouts** (B3): pay a vendor's bill to its bank account in Mexico over SPEI, through BlindPay. An owner
 * accepts BlindPay's terms on BlindPay's page and comes back set up. In this version the workspace is set up on BlindPay's
 * development instance, with BlindPay's test business values; real KYB is BlindPay's production review.
 */
export default function BankPayoutsPanel({ orgSlug, view, canSetUp, notice }: { orgSlug: string; view: BankPayoutsView; canSetUp: boolean; notice: string | null }) {
  const told = notice ? BANK_PAYOUTS_NOTICES[notice] : undefined;
  return (
    <section aria-labelledby="bank-payouts-title" id="bank-payouts">
      <SectionHeader id="bank-payouts-title" title="Bank payouts" action={<DocsLink href="/docs/guides/bank-payouts" topic="Bank payouts" />} />
      <Card className="space-y-4 p-5">
        {told && (
          <p role="status" className={told.tone === "success" ? "text-sm text-ink" : "text-sm text-refused"}>
            {told.text}
          </p>
        )}
        <p className="max-w-prose text-sm text-ink-2">
          Pay a vendor who wants pesos, not USDC: its bill is paid to its bank account in Mexico over SPEI, through BlindPay. The workspace pays the bill&apos;s
          USDC; the vendor receives pesos, and a person sees how many before approving each payout.
        </p>
        {view.state === "not_set_up" ? (
          <p className="text-sm text-ink-2">Bank payouts are not set up on this deployment yet.</p>
        ) : view.state === "not_started" ? (
          canSetUp ? (
            <Start orgSlug={orgSlug} />
          ) : (
            <p className="text-sm text-ink-3">An owner sets up bank payouts.</p>
          )
        ) : (
          <ul className="space-y-1 text-sm text-ink-2">
            <li className="font-semibold text-ink">Set up with BlindPay</li>
            <li>{view.kybStatus ? (KYB_WORDS[view.kybStatus] ?? "BlindPay is checking the business") : "BlindPay is checking the business"}.</li>
            <li>{view.vendors === 0 ? "No vendor is paid to a bank account yet." : view.vendors === 1 ? "1 vendor is paid to a bank account." : `${view.vendors} vendors are paid to a bank account.`}</li>
            <li className="text-ink-3">BlindPay&apos;s development instance: payouts are tested, and no pesos reach a bank.</li>
          </ul>
        )}
      </Card>
    </section>
  );
}
