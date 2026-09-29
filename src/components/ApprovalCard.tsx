"use client";

import { Banknote, Undo2, X } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import { approveInvoiceAction, rejectInvoiceAction, returnInvoiceAction } from "@/app/actions/approvals";
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Textarea } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm, type ActionResult } from "@/components/ui/useActionForm";
import { Money, fmt } from "@/components/vx/Primitives";
import { withSuccessToast } from "@/components/withSuccessToast";
import type { WaitingPayable } from "@/lib/agent/approvals";
import { utcMinute } from "@/lib/copy";

const INITIAL: ActionResult = { ok: false, message: "" };
const approve = withSuccessToast(approveInvoiceAction);
const reject = withSuccessToast(rejectInvoiceAction);
const giveBack = withSuccessToast(returnInvoiceAction);

/** What Approve and pay asks before it pays; a sandbox's payment is simulated, and says so. */
export function payConfirmTitle(payable: Pick<WaitingPayable, "amount" | "counterpartyName">, sandbox: boolean): string {
  return `Pay ${fmt(payable.amount)} USDC to ${payable.counterpartyName} now?${sandbox ? " (simulated)" : ""}`;
}

const STATUS: Record<WaitingPayable["status"], { label: string; tone: BadgeProps["tone"] }> = {
  held: { label: "Held", tone: "held" },
  flagged: { label: "Flagged", tone: "refused" },
  awaiting_info: { label: "Awaiting information", tone: "neutral" },
  processing: { label: "Being decided", tone: "agent" },
};

/** A `processing` row whose claim did not finish, and which anyone may now decide again. */
const UNFINISHED: { label: string; tone: BadgeProps["tone"] } = { label: "Unfinished decision", tone: "held" };

/**
 * One payable the agent stopped on, and the three things a person can do
 * with it: pay it now, reject it, or hand it back to the agent's next cycle.
 * Someone without `approval.decide` sees the card and no buttons; a row
 * another person is deciding right now says so and offers nothing. A claim
 * that did not finish — the server marks it `reclaimable` once it is over 10
 * minutes old — offers the three decisions again, and says why.
 *
 * Paying is refused here before the server refuses it — the person who
 * created the invoice cannot approve it, nor can anyone pay a counterparty
 * screened high risk — and the card says which.
 */
export default function ApprovalCard({
  orgSlug,
  payable,
  canDecide,
  viewerId,
  sandbox,
}: {
  orgSlug: string;
  payable: WaitingPayable;
  canDecide: boolean;
  viewerId: string;
  sandbox: boolean;
}) {
  const unfinished = payable.status === "processing" && payable.reclaimable;
  const status = unfinished ? UNFINISHED : STATUS[payable.status];
  const processing = payable.status === "processing" && !payable.reclaimable;

  return (
    <Card asChild tone={payable.status === "flagged" ? "refused" : processing ? "agent" : "held"}>
      <article>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <CardTitle className="truncate">{payable.counterpartyName}</CardTitle>
            <p className="text-sm text-ink-2">
              Due {payable.dueDate}
              {payable.decidedAt && <span className="text-ink-3"> · stopped {utcMinute(payable.decidedAt)}</span>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end sm:gap-1.5">
            <Money value={payable.amount} className="text-lg font-semibold text-ink" />
            <Badge tone={status.tone} dot size="sm">
              {status.label}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-reasoning text-ink-2">{payable.reasoning?.trim() || "The agent recorded no reasoning."}</p>
          {unfinished && (
            <p className="mt-2 text-sm text-ink-2">
              An earlier decision did not finish. If it was a payment, Approve and pay records it without paying twice.
            </p>
          )}
        </CardContent>
        {processing ? (
          <CardFooter>
            <p className="text-sm text-ink-2">Being decided by someone else right now.</p>
          </CardFooter>
        ) : canDecide ? (
          <Decisions orgSlug={orgSlug} payable={payable} viewerId={viewerId} sandbox={sandbox} />
        ) : null}
      </article>
    </Card>
  );
}

function Decisions({ orgSlug, payable, viewerId, sandbox }: { orgSlug: string; payable: WaitingPayable; viewerId: string; sandbox: boolean }) {
  const approveForm = useActionForm(approve, INITIAL);
  const returnForm = useActionForm(giveBack, INITIAL);
  // Both forms report in one place: whichever was submitted last.
  const [last, setLast] = useState<"approve" | "return" | null>(null);
  const shown = last === "approve" ? approveForm.state : last === "return" ? returnForm.state : INITIAL;

  const blocked = payable.createdBy === viewerId ? "You created this invoice" : payable.riskLevel === "high" ? "Screened high risk" : null;
  const approveId = `approve-${payable.id}`;
  const returnId = `return-${payable.id}`;
  const blockedId = `${approveId}-blocked`;

  function submitting(which: "approve" | "return", onSubmit: (event: FormEvent<HTMLFormElement>) => void) {
    return (event: FormEvent<HTMLFormElement>) => {
      setLast(which);
      onSubmit(event);
    };
  }

  return (
    <CardFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
      <FormMessage tone={shown.message ? (shown.ok ? "success" : "error") : "neutral"}>{shown.message}</FormMessage>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {blocked && (
          <p id={blockedId} className="text-xs text-ink-3">
            {blocked}
          </p>
        )}
        <form id={approveId} className="contents" {...approveForm.formProps} onSubmit={submitting("approve", approveForm.formProps.onSubmit)}>
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="invoiceId" value={payable.id} />
        </form>
        <ConfirmDialog
          formId={approveId}
          tone="primary"
          trigger={
            <Button size="sm" icon={<Banknote />} loading={approveForm.pending} disabled={blocked !== null} aria-describedby={blocked ? blockedId : undefined}>
              Approve and pay
            </Button>
          }
          title={payConfirmTitle(payable, sandbox)}
          description="The transfer starts as soon as you confirm, and the ledger records who approved it."
          confirmLabel="Pay now"
        />
        <RejectDialog orgSlug={orgSlug} payable={payable} />
        <form id={returnId} className="contents" {...returnForm.formProps} onSubmit={submitting("return", returnForm.formProps.onSubmit)}>
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="invoiceId" value={payable.id} />
        </form>
        <ConfirmDialog
          formId={returnId}
          tone="primary"
          trigger={
            <Button size="sm" variant="ghost" icon={<Undo2 />} loading={returnForm.pending}>
              Return to agent
            </Button>
          }
          title={`Return ${payable.counterpartyName}'s invoice to the agent?`}
          description="It goes back to pending, and the agent's next cycle decides it again."
          confirmLabel="Return to agent"
        />
      </div>
    </CardFooter>
  );
}

function RejectDialog({ orgSlug, payable }: { orgSlug: string; payable: WaitingPayable }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { state, formProps } = useActionForm(reject, INITIAL, { resetOnSuccess: true, onSuccess: close });
  const reasonId = `reject-reason-${payable.id}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="danger" icon={<X />}>
          Reject
        </Button>
      </DialogTrigger>
      <DialogContent title={`Reject ${payable.counterpartyName}'s invoice?`} description="The invoice is not paid. The reason is kept in the ledger, not on the invoice.">
        <form {...formProps} className="grid gap-5">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="invoiceId" value={payable.id} />
          <Field id={reasonId} label="Reason" optional description="At most 280 characters.">
            <Textarea name="reason" maxLength={280} rows={3} />
          </Field>
          <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <SubmitButton variant="danger-solid" pendingLabel="Rejecting…">
              Reject
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
