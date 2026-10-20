"use client";

import { Mail } from "lucide-react";
import { signInWithEmail, type LoginState } from "@/app/login/actions";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: LoginState = { ok: false, message: "" };

/**
 * The address stays in the field after sending, so a mistyped one is visible
 * next to the confirmation that names it.
 *
 * Until there is a message, its live region is visually hidden rather than
 * removed: it stays in the page for a screen reader to announce the first one,
 * and leaves no empty line under the button. In a flex column, a hidden region
 * takes no gap either.
 */
export default function LoginForm({ next }: { next: string }) {
  const { state, formProps } = useActionForm(signInWithEmail, INITIAL);
  return (
    <form {...formProps} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <Field id="email" label="Work email">
        <Input name="email" type="email" autoComplete="email" required placeholder="name@company.com" />
      </Field>
      <SubmitButton icon={<Mail />} pendingLabel="Sending…" className="w-full">
        Email me a sign-in link
      </SubmitButton>
      <FormMessage tone={state.message ? (state.ok ? "success" : "error") : "neutral"} className="empty:sr-only">
        {state.message}
      </FormMessage>
    </form>
  );
}
