"use client";

import { Check } from "lucide-react";
import { acceptInvitationAction, type AcceptInvitationResult } from "@/app/invite/actions";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: AcceptInvitationResult = { ok: false, message: "" };

/** Success redirects into the workspace, so the only message ever shown here is a refusal. */
export default function AcceptInvitationForm({ token }: { token: string }) {
  const { state, formProps } = useActionForm(acceptInvitationAction, INITIAL);
  return (
    <Card asChild className="space-y-3 p-5 sm:p-6">
      <form {...formProps}>
        <input type="hidden" name="token" value={token} />
        <SubmitButton icon={<Check />} pendingLabel="Accepting…" className="w-full">
          Accept invitation
        </SubmitButton>
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
      </form>
    </Card>
  );
}
