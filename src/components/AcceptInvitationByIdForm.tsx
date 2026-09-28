"use client";

import { useActionState } from "react";
import { acceptInvitationByIdAction, type AcceptInvitationResult } from "@/app/invite/actions";

const INITIAL: AcceptInvitationResult = { ok: false, message: "" };

/** Success redirects into the workspace, so the only message ever shown here is a refusal. */
export default function AcceptInvitationByIdForm({ invitationId }: { invitationId: string }) {
  const [state, action, pending] = useActionState(acceptInvitationByIdAction, INITIAL);
  return (
    <form action={action} className="flex shrink-0 flex-col items-end gap-1">
      <input type="hidden" name="invitationId" value={invitationId} />
      <button
        type="submit"
        disabled={pending}
        className="brand-shadow h-9 rounded-lg bg-agent px-3.5 text-sm font-semibold text-on-agent transition-transform hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-70"
      >
        {pending ? "Accepting…" : "Accept"}
      </button>
      {!state.ok && state.message && <span className="text-xs text-refused">{state.message}</span>}
    </form>
  );
}
