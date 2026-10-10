"use client";

import Link from "next/link";
import { requestGuidedSetupAction } from "@/app/studios/actions";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { CONSENT, CONTRACTOR_COUNTS, HONEYPOT_FIELD, INVOICE_ARRIVALS, MESSAGE_MAX, TOKEN_FIELD } from "@/lib/growth/guided-setup";
import type { GuidedSetupResult } from "@/lib/growth/inbound";

const INITIAL: GuidedSetupResult = { ok: false, message: "" };

/**
 * The guided setup request on /studios. `token` is signed when the page is drawn (src/lib/growth/guided-setup.ts); a
 * refusal keeps what was typed and marks the field it is about, and a thank-you replaces the form once it is sent.
 */
export function GuidedSetupForm({ token }: { token: string }) {
  const { state, formProps } = useActionForm(requestGuidedSetupAction, INITIAL);
  if (state.ok) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <FormMessage tone="success">{state.message}</FormMessage>
      </div>
    );
  }
  const error = (name: string) => (!state.ok && state.field === name ? state.message : undefined);
  return (
    <form {...formProps} className="grid gap-4 rounded-2xl border border-line bg-surface p-5 sm:grid-cols-2 sm:p-6" noValidate={false}>
      <input type="hidden" name={TOKEN_FIELD} value={token} />
      {/* A person never sees or reaches this field; a bot that fills every input fills it too. */}
      <div aria-hidden className="absolute -left-[9999px] top-auto size-px overflow-hidden">
        <label htmlFor="guided-setup-nickname">Leave this empty</label>
        <Input id="guided-setup-nickname" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>
      <Field id="guided-setup-name" label="Your name" error={error("name")}>
        <Input name="name" autoComplete="name" maxLength={100} required />
      </Field>
      <Field id="guided-setup-email" label="Work email" error={error("email")}>
        <Input name="email" type="email" autoComplete="email" maxLength={200} required />
      </Field>
      <Field id="guided-setup-studio" label="Studio name" error={error("studio")}>
        <Input name="studio" autoComplete="organization" maxLength={200} required />
      </Field>
      <Field id="guided-setup-website" label="Studio website" optional error={error("website")}>
        <Input name="website" type="url" inputMode="url" placeholder="https://" autoComplete="url" maxLength={500} />
      </Field>
      <Field id="guided-setup-contractors" label="Contractors paid per month" error={error("contractors")}>
        <Select name="contractors" required>
          <SelectTrigger>
            <SelectValue placeholder="Choose one" />
          </SelectTrigger>
          <SelectContent>
            {CONTRACTOR_COUNTS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field id="guided-setup-arrival" label="How invoices arrive" error={error("arrival")}>
        <Select name="arrival" required>
          <SelectTrigger>
            <SelectValue placeholder="Choose one" />
          </SelectTrigger>
          <SelectContent>
            {INVOICE_ARRIVALS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field id="guided-setup-message" label="Anything else" optional description={`At most ${MESSAGE_MAX} characters.`} error={error("message")} className="sm:col-span-2">
        <Textarea name="message" maxLength={MESSAGE_MAX} rows={3} />
      </Field>
      <div className="grid gap-3 sm:col-span-2">
        <FormMessage tone="error">{state.field ? null : state.message || null}</FormMessage>
        <div>
          <SubmitButton size="lg" pendingLabel="Sending…">
            Ask for a guided setup
          </SubmitButton>
        </div>
        <p className="text-xs leading-relaxed text-ink-3">
          {CONSENT}{" "}
          <Link href="/privacy#guided-setup" className="font-medium text-agent underline-offset-2 hover:underline">
            Privacy
          </Link>
        </p>
      </div>
    </form>
  );
}
