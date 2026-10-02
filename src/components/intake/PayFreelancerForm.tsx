"use client";

import { Send } from "lucide-react";
import { payFreelancerAction, type PayFreelancerResult } from "@/app/actions/pay-freelancer";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { utcDay } from "@/lib/copy";

const INITIAL: PayFreelancerResult = { ok: false, message: "" };

/**
 * Pay a freelancer in one step (docs/superpowers/specs/2026-10-01-pay-a-freelancer-design.md):
 * who, for what and how much; the link they add their address through is
 * emailed to them, and shown here once to copy.
 */
export default function PayFreelancerForm({ orgSlug, live }: { orgSlug: string; live: boolean }) {
  const { state, formProps } = useActionForm(payFreelancerAction, INITIAL, { resetOnSuccess: true });

  return (
    <div className="space-y-5">
      <form {...formProps} className="space-y-4">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="freelancer-name" label="Freelancer's name">
            <Input name="name" required minLength={2} maxLength={160} placeholder="Linh Tran" autoComplete="off" />
          </Field>
          <Field id="freelancer-email" label="Freelancer's email" optional description="They get the link to add the address they want to be paid at.">
            <Input name="email" type="email" maxLength={254} placeholder="linh@example.com" autoComplete="off" />
          </Field>
          <Field id="freelancer-work" label="What they delivered" className="sm:col-span-2">
            <Input name="work" required minLength={3} maxLength={160} placeholder="10 social posts for October" />
          </Field>
          <Field id="freelancer-amount" label="Amount (USDC)">
            <Input name="amount" required inputMode="decimal" placeholder="25.00" />
          </Field>
          <Field id="freelancer-evidence" label="Link to the work" optional>
            <Input name="evidence" type="url" maxLength={500} placeholder="https://www.canva.com/design/…" />
          </Field>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
          <SubmitButton icon={<Send />} pendingLabel="Setting up…" className="shrink-0">
            Set up payment
          </SubmitButton>
        </div>
        <p className="text-xs leading-5 text-ink-3">
          Adds them as a contractor with this amount as their limit, and records that you confirmed the work was delivered.{" "}
          {live
            ? "Nothing is paid until they add an address and someone here confirms it."
            : "This is a sandbox: the agent pays them simulated, within a minute."}
        </p>
      </form>
      {state.ok && state.url && state.expiresAt && <PaymentLinkReady message={state.message} url={state.url} expiresAt={state.expiresAt} />}
    </div>
  );
}

/** The payment just set up, and its link, shown this once: it is never stored where anyone can read it again. */
export function PaymentLinkReady({ message, url, expiresAt }: { message: string; url: string; expiresAt: string }) {
  return (
    <div role="status" className="grid gap-3 rounded-xl border border-proof-line bg-proof-soft p-4">
      <p className="text-sm leading-6 text-ink">{message}</p>
      <div className="flex items-center gap-2">
        <Input readOnly value={url} aria-label="Payee link" className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
        <CopyButton value={url} label="Copy link" variant="secondary">
          Copy link
        </CopyButton>
      </div>
      <p className="text-xs text-ink-3">The link works once and expires {utcDay(expiresAt)}. It is shown only now; make a new one on Counterparties if it is lost.</p>
    </div>
  );
}
