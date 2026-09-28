"use client";

import { useActionState } from "react";
import { createWorkspaceAction, type CreateWorkspaceResult } from "@/app/onboarding/actions";

const INITIAL: CreateWorkspaceResult = { ok: false, message: "" };

/** Success navigates to the new workspace, so the only message shown here is a refusal. */
export default function CreateWorkspaceForm() {
  const [state, action, pending] = useActionState(createWorkspaceAction, INITIAL);
  return (
    <form action={action} className="surface-shadow space-y-3 rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <label className="block text-sm font-medium text-ink" htmlFor="workspace-name">Workspace name</label>
      {/* 16px below `sm`: iOS zooms the page into any smaller field it focuses. */}
      <input
        id="workspace-name"
        name="name"
        type="text"
        required
        maxLength={80}
        autoComplete="organization"
        className="h-11 w-full rounded-xl border border-line-strong bg-ground px-3 text-base text-ink outline-none focus:border-agent focus:ring-2 focus:ring-agent-soft sm:text-sm"
      />
      <button
        type="submit"
        disabled={pending}
        className="brand-shadow h-11 w-full rounded-xl bg-agent px-3.5 text-sm font-semibold text-on-agent transition-transform hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-70"
      >
        {pending ? "Creating…" : "Create workspace"}
      </button>
      {state.message && (
        <p aria-live="polite" className={state.ok ? "text-sm text-ink-3" : "text-sm text-refused"}>{state.message}</p>
      )}
    </form>
  );
}
