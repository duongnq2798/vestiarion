"use client";

import { UserX } from "lucide-react";
import { useCallback, useState } from "react";
import { dismissScreeningMatchAction, type DismissMatchResult } from "@/app/actions/compliance";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Textarea } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";

const INITIAL: DismissMatchResult = { ok: false, message: "" };
const dismiss = withSuccessToast(dismissScreeningMatchAction);

export interface ScreeningMatchProps {
  orgSlug: string;
  counterparty: { id: string; name: string; riskLevel: string; riskNotes: string | null; riskEntityId: string | null };
  /** Whether the viewer can decide approvals, and so dismiss a match (dismiss screening match R1). */
  canDismiss: boolean;
}

/**
 * A counterparty's screening match on its card (docs/superpowers/specs/2026-10-01-dismiss-screening-match-design.md):
 * who it matched and what that does to its limit, and, for a live match, Not this person.
 */
export default function ScreeningMatch({ orgSlug, counterparty, canDismiss }: ScreeningMatchProps) {
  if ((counterparty.riskLevel !== "medium" && counterparty.riskLevel !== "high") || !counterparty.riskNotes) return null;
  const effect =
    counterparty.riskLevel === "high" ? "High risk: the agent pays it nothing." : "Medium risk: the agent pays it at most a quarter of its limit.";

  return (
    <div className="mt-3 rounded-lg border border-held-line bg-held-soft px-3 py-2 text-xs leading-5">
      <p className="text-ink">
        <span className="font-semibold">Screening match:</span> <span className="break-words">{counterparty.riskNotes}</span>
      </p>
      <p className="text-ink-2">{effect}</p>
      {canDismiss && counterparty.riskEntityId && (
        <div className="mt-1.5">
          <DismissDialog orgSlug={orgSlug} counterparty={counterparty} entityId={counterparty.riskEntityId} />
        </div>
      )}
    </div>
  );
}

function DismissDialog({ orgSlug, counterparty, entityId }: { orgSlug: string; counterparty: ScreeningMatchProps["counterparty"]; entityId: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { state, formProps } = useActionForm(dismiss, INITIAL, { resetOnSuccess: true, onSuccess: close });
  const reasonId = `dismiss-reason-${counterparty.id}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" icon={<UserX />}>
          Not this person
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Is ${counterparty.name} someone else?`}
        description={`Only if you have checked. The match is dismissed for ${counterparty.name} alone, ${counterparty.name} is screened again at once, and a match with anyone else still counts. Your reason is signed in the ledger.`}
      >
        <form {...formProps} className="grid gap-5">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="counterpartyId" value={counterparty.id} />
          <input type="hidden" name="matchedEntityId" value={entityId} />
          <Field id={reasonId} label="Why it is not the same person" description="3 to 280 characters, kept in the ledger.">
            <Textarea name="reason" required minLength={3} maxLength={280} rows={3} placeholder="Our freelancer since 2025; not a public official." />
          </Field>
          <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <SubmitButton pendingLabel="Dismissing…">Dismiss the match</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
