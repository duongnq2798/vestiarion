"use client";

import { Check, ShieldAlert } from "lucide-react";
import { answerAddressChangeAction, type AddressChangeAnswerResult } from "@/app/address-change/[token]/actions";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { changedAtWords, shortAddress, viaWords, type AddressChangeVia } from "@/lib/address-change-check-words";

const INITIAL: AddressChangeAnswerResult = { ok: false, message: "" };

export interface AddressChangeShown {
  orgName: string;
  payeeName: string;
  from: string;
  to: string;
  via: AddressChangeVia;
  githubLogin: string | null;
  changedAt: string;
}

/**
 * The payee's page of "Was this you?" (docs/superpowers/specs/2026-10-22-address-change-check-design.md AC3): which
 * business, both addresses, when and how the address changed, and the two answers. One answer, then the page says what
 * happens next. Opening it changes nothing; only a button does.
 */
export function AddressChangeAnswer({ token, change }: { token: string; change: AddressChangeShown }) {
  const { state, formProps } = useActionForm(answerAddressChangeAction, INITIAL);
  return (
    <Card className="space-y-5 p-6">
      <div className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-wide text-ink-3">Your payment address</p>
        <h1 className="text-xl font-semibold text-ink [text-wrap:balance]">Did you change where {change.orgName} pays you?</h1>
        <p className="text-sm text-ink-2">
          The address {change.orgName} pays {change.payeeName} at was changed {viaWords(change.via, change.orgName, change.githubLogin)}, on{" "}
          {changedAtWords(change.changedAt)}.
        </p>
      </div>
      <dl className="grid gap-2 rounded-xl border border-line bg-surface p-4 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <dt className="w-16 shrink-0 text-ink-3">Before</dt>
          <dd className="font-mono text-ink">{shortAddress(change.from)}</dd>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3">
          <dt className="w-16 shrink-0 text-ink-3">Now</dt>
          <dd className="min-w-0 break-all font-mono text-ink">{change.to}</dd>
        </div>
      </dl>
      {state.ok ? (
        <p role="status" className="text-sm text-ink">
          {state.message}
        </p>
      ) : (
        <form {...formProps} className="space-y-3">
          <input type="hidden" name="token" value={token} />
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton name="answer" value="me" variant="secondary" pendingLabel="Sending…" icon={<Check aria-hidden />}>
              Yes, I made this change
            </SubmitButton>
            <SubmitButton name="answer" value="not_me" variant="danger" pendingLabel="Sending…" icon={<ShieldAlert aria-hidden />}>
              No, this wasn&apos;t me
            </SubmitButton>
          </div>
          <p className="text-xs text-ink-3">If it wasn&apos;t you, payments to the new address stop until someone at {change.orgName} checks with you. This page never asks for a password, a key or a payment.</p>
          <FormMessage tone={state.message ? "error" : "neutral"}>{state.message}</FormMessage>
        </form>
      )}
    </Card>
  );
}
