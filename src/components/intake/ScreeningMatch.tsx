"use client";

import { RefreshCw, UserX } from "lucide-react";
import { useCallback, useState } from "react";
import { dismissScreeningMatchAction, screenAgainAction, type DismissMatchResult } from "@/app/actions/compliance";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Textarea } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";
import type { ScreeningCandidate } from "@/lib/compliance";

const INITIAL: DismissMatchResult = { ok: false, message: "" };
const dismiss = withSuccessToast(dismissScreeningMatchAction);
const screenAgain = withSuccessToast(screenAgainAction);

export interface ScreeningMatchProps {
  orgSlug: string;
  counterparty: {
    id: string;
    name: string;
    riskLevel: string;
    riskNotes: string | null;
    riskEntityId: string | null;
    /** Every match the latest live screening kept, best first (review every match R2); null before it kept them. */
    matches?: ScreeningCandidate[] | null;
  };
  /** Whether the viewer can decide approvals, and so dismiss a match (dismiss screening match R1). */
  canDismiss: boolean;
  /** Screening is live, so a match names the entity it matched (R6); a bundled match never does. */
  liveScreening?: boolean;
}

/**
 * A counterparty's screening match on its card (docs/superpowers/specs/2026-10-01-dismiss-screening-match-design.md):
 * who it matched and what that does to its limit, and, for a live match, Not this person, which lists every
 * match the screening kept so one review dismisses them all (docs/superpowers/specs/2026-10-02-review-every-match-design.md).
 */
export default function ScreeningMatch({ orgSlug, counterparty, canDismiss, liveScreening = false }: ScreeningMatchProps) {
  if ((counterparty.riskLevel !== "medium" && counterparty.riskLevel !== "high") || !counterparty.riskNotes) return null;
  const effect =
    counterparty.riskLevel === "high" ? "High risk: the agent pays it nothing." : "Medium risk: the agent pays it at most a quarter of its limit.";
  const matches = counterparty.matches ?? [];
  // Reviewable once the screening named the verdict's match and kept every match with it.
  const reviewable = Boolean(counterparty.riskEntityId) && matches.some((match) => match.id === counterparty.riskEntityId);
  const others = reviewable ? matches.length - 1 : 0;

  return (
    <div className="mt-3 rounded-lg border border-held-line bg-held-soft px-3 py-2 text-xs leading-5">
      <p className="text-ink">
        <span className="font-semibold">Screening match:</span> <span className="break-words">{counterparty.riskNotes}</span>
      </p>
      <p className="text-ink-2">{effect}</p>
      {others > 0 && (
        <p className="text-ink-2">
          The name also matched {others} other {others === 1 ? "person" : "people"}; Not this person lists them all.
        </p>
      )}
      {canDismiss && reviewable && counterparty.riskEntityId && (
        <div className="mt-1.5">
          <DismissDialog orgSlug={orgSlug} counterparty={counterparty} matches={matches} />
        </div>
      )}
      {/* A live match recorded before the screening kept every match it found: screened again, it lists them. */}
      {canDismiss && !reviewable && liveScreening && <ScreenAgain orgSlug={orgSlug} counterpartyId={counterparty.id} />}
    </div>
  );
}

function ScreenAgain({ orgSlug, counterpartyId }: { orgSlug: string; counterpartyId: string }) {
  const { state, pending, formProps } = useActionForm(screenAgain, INITIAL);
  return (
    <form {...formProps} className="mt-1.5 space-y-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="counterpartyId" value={counterpartyId} />
      <p className="text-ink-2">This match was recorded before Vestiarion kept every possible match. Screen it again to review them all.</p>
      <SubmitButton size="sm" variant="secondary" icon={<RefreshCw />} pendingLabel="Screening…" disabled={pending}>
        Screen again
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

function DismissDialog({ orgSlug, counterparty, matches }: { orgSlug: string; counterparty: ScreeningMatchProps["counterparty"]; matches: ScreeningCandidate[] }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const many = matches.length > 1;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" icon={<UserX />}>
          Not this person
        </Button>
      </DialogTrigger>
      <DialogContent
        title={many ? `Is ${counterparty.name} none of these ${matches.length} people?` : `Is ${counterparty.name} someone else?`}
        description={
          many
            ? `Only if you have checked each one. All ${matches.length} matches are dismissed for ${counterparty.name} alone, ${counterparty.name} is screened again at once, and a match with anyone not listed here still counts. Your reason is signed in the ledger.`
            : `Only if you have checked. The match is dismissed for ${counterparty.name} alone, ${counterparty.name} is screened again at once, and a match with anyone else still counts. Your reason is signed in the ledger.`
        }
      >
        <DismissForm orgSlug={orgSlug} counterparty={counterparty} matches={matches} onDone={close} />
      </DialogContent>
    </Dialog>
  );
}

/** What the reviewer confirms: every match listed, with one reason. Each listed match is sent, the verdict's among them. */
export function DismissForm({
  orgSlug,
  counterparty,
  matches,
  onDone,
}: {
  orgSlug: string;
  counterparty: ScreeningMatchProps["counterparty"];
  matches: ScreeningCandidate[];
  onDone?: () => void;
}) {
  const { state, formProps } = useActionForm(dismiss, INITIAL, { resetOnSuccess: true, onSuccess: onDone });
  const reasonId = `dismiss-reason-${counterparty.id}`;
  const many = matches.length > 1;
  return (
    <form {...formProps} className="grid gap-5">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="counterpartyId" value={counterparty.id} />
      {matches.map((match) => (
        <input key={match.id} type="hidden" name="matchedEntityId" value={match.id} />
      ))}
      {many && (
        <ul aria-label="Every match" className="max-h-56 divide-y divide-line overflow-y-auto rounded-lg border border-line text-sm">
          {matches.map((match) => (
            <li key={match.id} className="flex items-baseline justify-between gap-3 px-3 py-2">
              <span className="min-w-0">
                <span className="block break-words text-ink">{match.caption}</span>
                {match.topics.length > 0 && <span className="block text-xs text-ink-3">{match.topics.join(", ")}</span>}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-ink-2">{match.score.toFixed(3)}</span>
            </li>
          ))}
        </ul>
      )}
      <Field id={reasonId} label="Why it is not the same person" description="3 to 280 characters, kept in the ledger.">
        <Textarea name="reason" required minLength={3} maxLength={280} rows={3} placeholder="Our freelancer since 2025; not a public official." />
      </Field>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">Cancel</Button>
        </DialogClose>
        <SubmitButton pendingLabel="Dismissing…">{many ? `Dismiss all ${matches.length} matches` : "Dismiss the match"}</SubmitButton>
      </DialogFooter>
    </form>
  );
}
