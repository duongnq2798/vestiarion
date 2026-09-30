"use client";

import { CircleCheck } from "lucide-react";
import { submitPayeeAddressAction, type PayeeAddressResult } from "@/app/payee/[token]/actions";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: PayeeAddressResult = { ok: false, message: "" };

/** The payee's one field. Once it is sent, the form gives way to what happens next. */
export default function PayeeAddressForm({ token }: { token: string }) {
  const { state, formProps } = useActionForm(submitPayeeAddressAction, INITIAL);

  if (state.ok) {
    return (
      <p role="status" className="flex items-start gap-2 rounded-xl border border-proof-line bg-proof-soft px-4 py-3 text-sm text-ink">
        <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-proof" />
        {state.message}
      </p>
    );
  }

  return (
    <form {...formProps} className="grid gap-4">
      <input type="hidden" name="token" value={token} />
      <Field id="payee-address" label="Your Arc address" description="0x followed by 40 hex characters, from any wallet that holds USDC on Arc testnet.">
        <Input name="address" required maxLength={200} autoComplete="off" spellCheck={false} className="font-mono" placeholder="0x…" />
      </Field>
      <FormMessage tone={state.message ? "error" : "neutral"}>{state.message || null}</FormMessage>
      <SubmitButton pendingLabel="Sending…">Send my address</SubmitButton>
    </form>
  );
}
