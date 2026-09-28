"use client";

import { useActionState } from "react";
import { acceptInvitationAction, type AcceptInvitationResult } from "@/app/invite/actions";

const INITIAL: AcceptInvitationResult = { ok: false, message: "" };

/** Success redirects into the workspace, so the only message ever shown here is a refusal. */
export default function AcceptInvitationForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(acceptInvitationAction, INITIAL);
  return (
    <form action={action} className="surface-shadow space-y-3 rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <input type="hidden" name="token" value={token} />
      <button
        type="submit"
        disabled={pending}
        className="brand-shadow h-11 w-full rounded-xl bg-agent px-3.5 text-sm font-semibold text-on-agent transition-transform hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-70"
      >
        {pending ? "Accepting…" : "Accept invitation"}
      </button>
      {state.message && (
        <p aria-live="polite" className={state.ok ? "text-sm text-ink-3" : "text-sm text-refused"}>
          {state.message}
        </p>
      )}
    </form>
  );
}
