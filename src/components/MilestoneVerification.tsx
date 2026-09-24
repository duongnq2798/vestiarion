"use client";

import { useActionState } from "react";
import { manualMilestoneVerificationAction, type MilestoneActionResult } from "@/app/actions/milestones";

const INITIAL: MilestoneActionResult = { ok: false, message: "" };

export default function MilestoneVerification({ milestoneId, verified, disabled }: { milestoneId: string; verified: boolean; disabled?: boolean }) {
  const [state, action, pending] = useActionState(manualMilestoneVerificationAction, INITIAL);
  return (
    <form action={action} className="mt-2 flex flex-col gap-2 rounded-md border border-line bg-ground/40 p-3 sm:flex-row sm:items-center">
      <input type="hidden" name="milestoneId" value={milestoneId} />
      <label className="min-w-0 flex-1">
        <span className="sr-only">Manual verification note</span>
        <input
          name="note"
          required
          minLength={3}
          maxLength={280}
          placeholder={verified ? "Reason for revoking verification" : "Evidence checked or approver note"}
          className="h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-agent"
        />
      </label>
      <button
        name="intent"
        value={verified ? "revoke" : "verify"}
        disabled={pending || disabled}
        className="h-9 shrink-0 rounded-md border border-line-strong px-3 text-sm font-medium text-ink hover:bg-raised disabled:opacity-60"
      >
        {pending ? "Recording…" : verified ? "Revoke manually" : "Verify manually"}
      </button>
      {state.message && <p aria-live="polite" className={`text-xs ${state.ok ? "text-proof" : "text-refused"}`}>{state.message}</p>}
    </form>
  );
}
