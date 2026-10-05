"use client";

import { Banknote, CircleSlash } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { closeMilestoneAction, payHeldMilestoneAction } from "@/app/actions/milestones";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Textarea } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm, type ActionResult } from "@/components/ui/useActionForm";
import { fmt } from "@/components/vx/Primitives";
import { withSuccessToast } from "@/components/withSuccessToast";
import type { HeldReason } from "@/lib/agent/milestone-decisions";
import { orgHref } from "@/lib/auth/org-paths";

const INITIAL: ActionResult = { ok: false, message: "" };

/** What the row says to a sole approver about a held milestone they added (sole approver R5). */
export const OWN_MILESTONE_NOTE =
  "You added this milestone. You are the only person in this workspace who can approve payments, so you can pay it yourself, and the ledger records that you did.";
const OWN_MILESTONE_RECORDED = "It also records that you added it yourself, as the workspace's only approver.";
const pay = withSuccessToast(payHeldMilestoneAction);
const close = withSuccessToast(closeMilestoneAction);

/**
 * A held milestone's row, opened (held milestone actions R1–R3): what it waits for, where to act on that, and a
 * person's two decisions on it, Pay now and Close without paying. Only someone who may approve a held payable
 * sees the decisions. Overriding the agent's own hold needs someone other than whoever added the milestone,
 * unless they are the workspace's sole approver, and then the row says so (sole approver R5).
 */
/**
 * What Pay now's confirmation says will happen: a transfer to record is only checked; one Circle never answered is
 * looked for on Circle first and sent only once Circle shows none (payment safety R4); one Circle failed is sent anew.
 */
export function payNowDescription(kind: HeldReason["kind"]): string {
  if (kind === "in_flight") return "Nothing new is sent: Vestiarion checks the transfer already made with Circle, and the ledger records who approved it.";
  if (kind === "unknown") return "Vestiarion looks for the earlier transfer on Circle first: it records it if Circle has it, and sends the payment only once Circle shows none. The ledger records who approved it.";
  if (kind === "transfer_failed") return "A new transfer starts as soon as you confirm, and the ledger records who approved it.";
  return "The transfer starts as soon as you confirm, and the ledger records who approved it.";
}

export function HeldMilestoneActions({
  orgSlug,
  milestone,
  reason,
  canDecide,
  selfAdded,
  sandbox,
  soleApprover = false,
}: {
  orgSlug: string;
  milestone: { id: string; title: string; amount: number; contractorName: string };
  reason: HeldReason;
  canDecide: boolean;
  /** The viewer added this milestone: overriding the agent's hold on it needs someone else. */
  selfAdded: boolean;
  sandbox: boolean;
  /** The viewer is the only member of the workspace who may approve payments: they may override a hold on what they added. */
  soleApprover?: boolean;
}) {
  const payForm = useActionForm(pay, INITIAL);
  const payId = `pay-held-${milestone.id}`;
  const blockedId = `${payId}-blocked`;
  const ownOverride = reason.canPay && reason.override && selfAdded;
  const selfBlocked = ownOverride && !soleApprover;
  const ownEntry = ownOverride && soleApprover;

  return (
    <Callout tone="held" title="What it waits for">
      <p>
        {reason.text}
        {reason.link && (
          <>
            {" "}
            <Button asChild variant="link">
              <Link href={orgHref(orgSlug, reason.link.path)}>Open {reason.link.label}</Link>
            </Button>
          </>
        )}
      </p>
      {canDecide ? (
        (reason.canPay || reason.canClose) && (
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-2">
              {reason.canPay && (
                <>
                  <form id={payId} className="contents" {...payForm.formProps}>
                    <input type="hidden" name="orgSlug" value={orgSlug} />
                    <input type="hidden" name="milestoneId" value={milestone.id} />
                  </form>
                  <ConfirmDialog
                    formId={payId}
                    tone="primary"
                    trigger={
                      <Button size="sm" icon={<Banknote />} loading={payForm.pending} disabled={selfBlocked} aria-describedby={selfBlocked ? blockedId : undefined}>
                        Pay now
                      </Button>
                    }
                    title={`Pay ${fmt(milestone.amount)} USDC to ${milestone.contractorName} now?${sandbox ? " (simulated)" : ""}`}
                    description={`${payNowDescription(reason.kind)}${ownEntry ? ` ${OWN_MILESTONE_RECORDED}` : ""}`}
                    confirmLabel="Pay now"
                  />
                </>
              )}
              {reason.canClose && <CloseDialog orgSlug={orgSlug} milestone={milestone} />}
              {selfBlocked && (
                <p id={blockedId} className="text-xs text-ink-3">
                  You added this milestone, so someone else must approve paying it.
                </p>
              )}
            </div>
            {ownEntry && <p className="mt-2 text-xs text-ink-3">{OWN_MILESTONE_NOTE}</p>}
            {/* Takes no room until Pay now has something to say. */}
            <FormMessage tone={payForm.state.message ? (payForm.state.ok ? "success" : "error") : "neutral"} className={payForm.state.message ? "mt-2" : "min-h-0"}>
              {payForm.state.message}
            </FormMessage>
          </div>
        )
      ) : (
        <p className="mt-1 text-xs text-ink-3">An owner, admin or approver can pay it now or close it.</p>
      )}
    </Callout>
  );
}

function CloseDialog({ orgSlug, milestone }: { orgSlug: string; milestone: { id: string; title: string; contractorName: string } }) {
  const [open, setOpen] = useState(false);
  const done = useCallback(() => setOpen(false), []);
  const { state, formProps } = useActionForm(close, INITIAL, { resetOnSuccess: true, onSuccess: done });
  const reasonId = `close-reason-${milestone.id}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="danger" icon={<CircleSlash />}>
          Close without paying
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Close "${milestone.title}" without paying?`}
        description={`${milestone.contractorName} is not paid for it, and the agent never decides it again. The reason is kept on the milestone and in the ledger.`}
      >
        <form {...formProps} className="grid gap-5">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="milestoneId" value={milestone.id} />
          <Field id={reasonId} label="Reason" description="Required. At most 500 characters.">
            <Textarea name="reason" required maxLength={500} rows={3} />
          </Field>
          <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <SubmitButton variant="danger-solid" pendingLabel="Closing…">
              Close without paying
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
