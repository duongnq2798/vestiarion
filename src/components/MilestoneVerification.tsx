"use client";

import { manualMilestoneVerificationAction, type MilestoneActionResult } from "@/app/actions/milestones";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: MilestoneActionResult = { ok: false, message: "" };

/** A person's own check of a milestone, recorded with a note; the agent pays verified milestones. */
export default function MilestoneVerification({ milestoneId, verified, disabled, orgSlug }: { milestoneId: string; verified: boolean; disabled?: boolean; orgSlug: string }) {
  const { state, pending, formProps } = useActionForm(manualMilestoneVerificationAction, INITIAL, { resetOnSuccess: true, toastOnSuccess: true });
  const noteId = `milestone-note-${milestoneId}`;

  return (
    <form {...formProps} className="mt-2 rounded-xl border border-line bg-ground/40 p-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="milestoneId" value={milestoneId} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label htmlFor={noteId} className="sr-only">
          Manual verification note
        </label>
        <Input
          id={noteId}
          name="note"
          size="sm"
          required
          minLength={3}
          maxLength={280}
          disabled={disabled || pending}
          placeholder={verified ? "Reason for revoking verification" : "Evidence checked or approver note"}
          className="h-11 sm:h-8"
        />
        <SubmitButton name="intent" value={verified ? "revoke" : "verify"} variant="secondary" size="sm" disabled={disabled} pendingLabel="Recording…" className="h-11 shrink-0 sm:h-8">
          {verified ? "Revoke manually" : "Verify manually"}
        </SubmitButton>
      </div>
      <FormMessage tone="error" className="mt-1 text-xs">
        {state.ok ? null : state.message}
      </FormMessage>
    </form>
  );
}
