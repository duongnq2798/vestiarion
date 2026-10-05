"use client";

import { Banknote, Undo2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useState, type FormEvent } from "react";
import { approveInvoiceAction, rejectInvoiceAction, returnInvoiceAction } from "@/app/actions/approvals";
import { AddDetailsDialog } from "@/components/AddDetailsDialog";
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
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
import { addedDetailsSentence } from "@/lib/added-details";
import { approvalAnchor, orgHref } from "@/lib/auth/org-paths";
import { agentResumes, CASH_SHORTFALL, counterpartyPath, ruleNextStep } from "@/lib/next-step";
import { amountToPay } from "@/lib/agent/payment-timing";
import { utcDay, utcMinute } from "@/lib/copy";
import { paidAcrossChains, payeeChain } from "@/lib/payee-chains";

const INITIAL: ActionResult = { ok: false, message: "" };
const approve = withSuccessToast(approveInvoiceAction);
const reject = withSuccessToast(rejectInvoiceAction);
const giveBack = withSuccessToast(returnInvoiceAction);

/**
 * What Approve and pay asks before it pays: the amount that will leave, which
 * is the discounted one while an early-payment discount still applies (the
 * same `amountToPay` rule `payInvoice` pays by), naming the discount; a
 * sandbox's payment is simulated, and says so.
 */
export function payConfirmTitle(
  payable: Pick<WaitingPayable, "amount" | "counterpartyName" | "discount"> &
    Partial<Pick<WaitingPayable, "currency" | "payeeChain" | "bridgeFeeUsdc">>,
  sandbox: boolean,
  now: Date = new Date()
): string {
  const { amountPaid, discountTaken } = amountToPay(payable.amount, payable.discount, now);
  const discount = discountTaken > 0 && payable.discount ? ` (${payable.discount.pct}% discount through ${utcDay(payable.discount.deadline)})` : "";
  // A payee on another chain: where the money goes, and the fee on top of it (CCTP payouts, review I2).
  const elsewhere = paidAcrossChains(payable.payeeChain) ? ` on ${payeeChain(payable.payeeChain).label}` : "";
  const fee = !elsewhere
    ? ""
    : payable.bridgeFeeUsdc != null
      ? ` The CCTP fee, about ${payable.bridgeFeeUsdc} USDC, comes on top.`
      : " A CCTP fee comes on top.";
  return `Pay ${fmt(amountPaid)} ${payable.currency ?? "USDC"} to ${payable.counterpartyName}${elsewhere} now?${discount}${sandbox ? " (simulated)" : ""}${fee}`;
}

/**
 * What the confirm dialog says will happen when Approve and pay is chosen. A
 * transfer already sent — including one still in flight — is only checked,
 * never sent again; a terminal failure is sent again, as a new transfer;
 * otherwise this is the first attempt. A sole approver approving what they
 * entered is told the ledger records that too (sole approver R5).
 */
export function payConfirmDescription(payable: Pick<WaitingPayable, "paymentSent" | "lastAttempt">, ownEntry = false): string {
  const own = ownEntry ? ` ${OWN_ENTRY_RECORDED}` : "";
  if (payable.paymentSent || payable.lastAttempt?.state === "in_flight" || (payable.lastAttempt?.state === "failed" && payable.lastAttempt.resend === false)) {
    return `Nothing new is sent: Vestiarion checks the transfer already made with Circle, and the ledger records who approved it.${own}`;
  }
  if (payable.lastAttempt?.state === "failed") {
    return `A new transfer starts as soon as you confirm, and the ledger records who approved it.${own}`;
  }
  return `The transfer starts as soon as you confirm, and the ledger records who approved it.${own}`;
}

/** The confirm dialog's added sentence when a sole approver approves what they entered themselves. */
export const OWN_ENTRY_RECORDED = "It also records that you entered it yourself, as the workspace's only approver.";

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
 * minutes old — offers the three decisions again, and says why. A row whose
 * payment was already sent offers only Approve and pay, which records it; the
 * server refuses Reject and Return for it too.
 *
 * The last payment attempt, when there is one worth reporting, says why: a
 * terminal failure names Circle's reason, and Approve and pay sends a new
 * transfer; a transfer still in flight says so instead of the sent-payment
 * line, and only Reject and Return go away — Approve and pay stays, since
 * approving it is the only way it is ever reconciled.
 *
 * Paying is refused here before the server refuses it — the person who
 * created the invoice cannot approve it, nor can anyone pay a counterparty
 * screened high risk — and the card says which. The workspace's sole approver
 * may approve what they entered (`soleApprover`: the viewer is the only
 * member who may approve payments), and the card says that instead.
 *
 * An owner or admin (`canEdit`) may instead add what the payable is missing —
 * its purchase order, or its goods marked received — while it waits and no
 * payment was sent for it; the agent then decides it again, and until it does
 * the card says what was added (complete held invoice R1, R3, R6).
 */
export default function ApprovalCard({
  orgSlug,
  payable,
  canDecide,
  viewerId,
  sandbox,
  soleApprover = false,
  canEdit = false,
}: {
  orgSlug: string;
  payable: WaitingPayable;
  canDecide: boolean;
  viewerId: string;
  sandbox: boolean;
  /** The viewer is the only member of the workspace who may approve payments. */
  soleApprover?: boolean;
  /** The viewer may enter records (`records.write`: owners and admins), so may add what the payable is missing. */
  canEdit?: boolean;
}) {
  const unfinished = payable.status === "processing" && payable.reclaimable;
  const ownEntry = soleApprover && payable.createdBy === viewerId;
  // A sole approver paying the first payment to an address they gave themselves (new payee check N4).
  const ownAddress = soleApprover && payable.firstPaymentAddressBy === viewerId;
  const status = unfinished ? UNFINISHED : STATUS[payable.status];
  const processing = payable.status === "processing" && !payable.reclaimable;
  const canAddDetails =
    canEdit &&
    payable.status !== "processing" &&
    !payable.paymentSent &&
    payable.lastAttempt?.state !== "in_flight" &&
    (payable.poReference === null || !payable.goodsReceived);

  return (
    <Card asChild tone={payable.status === "flagged" ? "refused" : processing ? "agent" : "held"}>
      <article id={approvalAnchor(payable.id)} className="scroll-mt-24">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <CardTitle className="truncate">{payable.counterpartyName}</CardTitle>
            <p className="text-sm text-ink-2">
              Due {utcDay(payable.dueDate)}
              {payable.decidedAt && <span className="text-ink-3"> · stopped {utcMinute(payable.decidedAt)}</span>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end sm:gap-1.5">
            <Money value={payable.amount} token={payable.currency ?? "USDC"} className="text-lg font-semibold text-ink" />
            <Badge tone={status.tone} dot size="sm">
              {status.label}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-reasoning text-ink-2">{payable.explanation || "The agent recorded no reasoning."}</p>
          <p className="mt-2 min-w-0 truncate text-xs text-ink-3" title={payable.address ?? undefined}>
            Pays to{" "}
            {payable.address ? <span className="font-mono text-ink-2">{payable.address}</span> : "no address set"}
            {paidAcrossChains(payable.payeeChain) && ` on ${payeeChain(payable.payeeChain).label}`}
          </p>
          {payable.addedSinceDecision && (
            <Callout tone="agent" className="mt-2">
              {addedDetailsSentence(payable.addedSinceDecision)}
            </Callout>
          )}
          {unfinished && (
            <p className="mt-2 text-sm text-ink-2">
              An earlier decision did not finish.
              {payable.lastAttempt?.state !== "failed" && " If it was a payment, Approve and pay records it without paying twice."}
            </p>
          )}
          {payable.paymentSent && payable.lastAttempt?.state !== "in_flight" && (
            <p className="mt-2 text-sm text-ink-2">A payment was already sent; Approve and pay records it.</p>
          )}
          {canDecide && !processing && ownEntry && payable.riskLevel !== "high" && <p className="mt-2 text-sm text-ink-2">{OWN_INVOICE_NOTE}</p>}
          {canDecide && !processing && (
            <ApprovalGuidance orgSlug={orgSlug} payable={payable} selfEntered={payable.createdBy === viewerId && !ownEntry} canEdit={canEdit} />
          )}
          {payable.lastAttempt?.state === "failed" && (
            <Callout tone="refused" className="mt-2">
              The last payment attempt failed: {payable.lastAttempt.reason}.{" "}
              {payable.lastAttempt.resend === false
                ? "Approving sends nothing new: check with Circle whether it was minted, and reject or return the invoice if it was not."
                : "Approving sends a new transfer."}
            </Callout>
          )}
          {payable.lastAttempt?.state === "in_flight" && (
            <Callout tone="held" className="mt-2">
              The payment is still in flight on Arc testnet. It cannot be rejected or returned until Circle settles it; approving checks it again.
            </Callout>
          )}
        </CardContent>
        {processing ? (
          <CardFooter>
            <p className="text-sm text-ink-2">Being decided by someone else right now.</p>
          </CardFooter>
        ) : canDecide ? (
          <Decisions orgSlug={orgSlug} payable={payable} viewerId={viewerId} sandbox={sandbox} ownEntry={ownEntry} ownAddress={ownAddress} canAddDetails={canAddDetails} />
        ) : null}
      </article>
    </Card>
  );
}

/** Why the person who entered an invoice may not approve it, and what they can do instead (approval guidance). */
export const SELF_APPROVAL_EXPLAINED =
  "Someone else must approve paying it: another owner, admin or approver of this workspace. The person who enters a bill never also approves it, so a payment made by hand always has two people behind it. You can still reject it or return it to the agent.";

/** Why a counterparty screened high risk cannot be paid, and the way through when the match is wrong. */
export const HIGH_RISK_EXPLAINED =
  "A counterparty screened high risk is never paid, not even by approval. If the screening matched someone else, review the match on its row in Counterparties and mark it Not this person: the agent then decides the invoice again. Otherwise, reject it.";

/** What the card says to a sole approver about an invoice they entered (sole approver R5). */
export const OWN_INVOICE_NOTE =
  "You entered this invoice. You are the only person in this workspace who can approve payments, so you can approve it yourself, and the ledger records that you did.";

function Decisions({
  orgSlug,
  payable,
  viewerId,
  sandbox,
  ownEntry,
  ownAddress,
  canAddDetails,
}: {
  orgSlug: string;
  payable: WaitingPayable;
  viewerId: string;
  sandbox: boolean;
  /** A sole approver deciding an invoice they entered: Approve and pay stays enabled. */
  ownEntry: boolean;
  /** A sole approver paying the first payment to an address they gave: Approve and pay stays enabled. */
  ownAddress: boolean;
  /** An owner or admin, on a payable missing its purchase order or goods receipt with no payment sent. */
  canAddDetails: boolean;
}) {
  const approveForm = useActionForm(approve, INITIAL);
  const returnForm = useActionForm(giveBack, INITIAL);
  // Both forms report in one place: whichever was submitted last.
  const [last, setLast] = useState<"approve" | "return" | null>(null);
  const shown = last === "approve" ? approveForm.state : last === "return" ? returnForm.state : INITIAL;

  const blocked =
    payable.createdBy === viewerId && !ownEntry
      ? "You created this invoice"
      : payable.firstPaymentAddressBy === viewerId && !ownAddress
        ? "You gave this payee's address"
        : payable.riskLevel === "high"
          ? "Screened high risk"
          : null;
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
          <input type="hidden" name="address" value={payable.address ?? ""} />
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
          description={payConfirmDescription(payable, ownEntry)}
          confirmLabel="Pay now"
        />
        {canAddDetails && <AddDetailsDialog orgSlug={orgSlug} payable={payable} />}
        {!payable.paymentSent && payable.lastAttempt?.state !== "in_flight" && (
          <>
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
          </>
        )}
      </div>
    </CardFooter>
  );
}

/**
 * Why Approve and pay is off, said in full, with what the person can do instead (approval guidance): the person who
 * entered the invoice learns who may approve it and what happens without them — the agent pays a payable stopped by
 * its spending limit on its own once there is room — and, as an owner or admin, gets the page that removes the cause;
 * a counterparty screened high risk points to its screening match.
 */
function ApprovalGuidance({
  orgSlug,
  payable,
  selfEntered,
  canEdit,
}: {
  orgSlug: string;
  payable: WaitingPayable;
  selfEntered: boolean;
  canEdit: boolean;
}) {
  if (payable.riskLevel === "high") {
    return (
      <Callout tone="refused" title="Screened high risk" className="mt-3">
        <p>{HIGH_RISK_EXPLAINED}</p>
        {canEdit && (
          <Button asChild size="sm" variant="secondary" className="mt-2">
            <Link href={orgHref(orgSlug, counterpartyPath(payable.counterpartyId))}>Review screening</Link>
          </Button>
        )}
      </Callout>
    );
  }
  if (!selfEntered) return null;
  const rule = payable.guardrailRule ?? (payable.heldForCash ? CASH_SHORTFALL : null);
  const resumes = agentResumes(rule);
  const fix = ruleNextStep(rule, { id: payable.counterpartyId, name: payable.counterpartyName })?.fix ?? null;
  return (
    <Callout tone="held" title="You entered this invoice" className="mt-3">
      <p>{SELF_APPROVAL_EXPLAINED}</p>
      {resumes && <p className="mt-1.5">{resumes}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {fix && canEdit && (
          <Button asChild size="sm" variant="secondary">
            <Link href={orgHref(orgSlug, fix.path)}>{fix.label}</Link>
          </Button>
        )}
        <Button asChild size="sm" variant="ghost">
          <Link href={orgHref(orgSlug, "/members")}>See who can approve</Link>
        </Button>
      </div>
    </Callout>
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
