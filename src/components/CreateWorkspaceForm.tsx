"use client";

import { useActionState } from "react";
import { createWorkspaceAction, type CreateWorkspaceResult } from "@/app/onboarding/actions";

const INITIAL: CreateWorkspaceResult = { ok: false, message: "" };

/** Success navigates to the new workspace, so the only message shown here is a refusal. */
export default function CreateWorkspaceForm() {
  const [state, action, pending] = useActionState(createWorkspaceAction, INITIAL);
  return (
    <form action={action} className="surface-shadow space-y-3 rounded-2xl border border-line bg-surface p-5">
      <label className="block text-sm font-medium text-ink" htmlFor="workspace-name">Workspace name</label>
      <input
        id="workspace-name"
        name="name"
        type="text"
        required
        maxLength={80}
        autoComplete="organization"
        className="w-full rounded-md border border-line bg-ground px-3 py-2 text-sm text-ink"
      />
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-ink px-3.5 py-2 text-sm font-medium text-ground disabled:opacity-70"
      >
        {pending ? "Creating…" : "Create workspace"}
      </button>
      {state.message && (
        <p aria-live="polite" className={state.ok ? "text-sm text-ink-3" : "text-sm text-refused"}>{state.message}</p>
      )}
    </form>
  );
}
