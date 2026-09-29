"use client";

import { acceptInvitationByIdAction, type AcceptInvitationResult } from "@/app/invite/actions";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: AcceptInvitationResult = { ok: false, message: "" };

/** Success redirects into the workspace, so the only message ever shown here is a refusal. */
export default function AcceptInvitationByIdForm({ invitationId }: { invitationId: string }) {
  const { state, formProps } = useActionForm(acceptInvitationByIdAction, INITIAL);
  return (
    <form {...formProps} className="flex shrink-0 flex-col items-end gap-1">
      <input type="hidden" name="invitationId" value={invitationId} />
      <SubmitButton size="sm" pendingLabel="Accepting…">
        Accept
      </SubmitButton>
      {!state.ok && state.message && (
        <p role="alert" className="text-xs text-refused">
          {state.message}
        </p>
      )}
    </form>
  );
}
