"use client";

import { CircleCheck, RefreshCw } from "lucide-react";
import { checkPaymentAction, type PaymentCheckResult } from "@/app/pay/[token]/actions";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: PaymentCheckResult = { ok: false, message: "" };

/** "I have paid" on a pay link: asks Vestiarion to look for the transfer now (receivables on Arc R5). */
export default function PaymentCheck({ token }: { token: string }) {
  const { state, formProps } = useActionForm(checkPaymentAction, INITIAL);

  if (state.received) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm font-medium text-proof">
        <CircleCheck aria-hidden className="size-4" />
        {state.message}
      </p>
    );
  }
  return (
    <form {...formProps} className="grid gap-3">
      <input type="hidden" name="token" value={token} />
      <SubmitButton variant="secondary" icon={<RefreshCw />} pendingLabel="Checking…">
        I have paid
      </SubmitButton>
      <FormMessage tone={state.ok ? "neutral" : "error"}>{state.message || null}</FormMessage>
    </form>
  );
}
