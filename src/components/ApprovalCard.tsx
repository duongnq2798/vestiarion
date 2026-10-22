"use client";

import { invoiceAskedFor, payToDiffers } from "@/lib/invoice-pay-to-rules";
import { Banknote, Undo2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useState, type FormEvent } from "react";
import { approveInvoiceAction, rejectInvoiceAction, returnInvoiceAction } from "@/app/actions/approvals";
import { AddDetailsDialog } from "@/components/AddDetailsDialog";
import { ExceptionLine } from "@/components/ExceptionLine";
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import VerdictControl from "@/components/VerdictControl";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm, type ActionResult } from "@/components/ui/useActionForm";
import { Money, fmt } from "@/components/vx/Primitives";
import { paymentSendingToast, paymentToastId, withPaymentReceipt } from "@/components/payment-toast";
import { withSuccessToast } from "@/components/withSuccessToast";
import type { WaitingPayable } from "@/lib/agent/approvals";
import { addedDetailsSentence } from "@/lib/added-details";
import { bankAccountLine, bankQuoteLine } from "@/lib/bank-payouts/words";
import { approvalAnchor, orgHref } from "@/lib/auth/org-paths";
import { agentResumes, CASH_SHORTFALL, SHADOW_VERDICT, counterpartyPath, ruleNextStep } from "@/lib/next-step";
import { amountToPay } from "@/lib/agent/payment-timing";
import { approvalCost } from "@/lib/approval-cost";
import type { ExceptionFacts } from "@/lib/exceptions";
import { utcDay, utcMinute } from "@/lib/copy";
import { chainById, homeChain, networkOfChain, paidAcrossChains } from "@/lib/payee-chains";
import { CHECK_FIRST_LABEL, checkFirstTitle, checksFirst, payActionOf } from "@/lib/payment-exceptions";
import { approveFirstDescription, mayApproveNow, onlyApproverOfTwo, SECOND_APPROVAL_PAYS, twoApprovalsLine } from "@/lib/two-approvals";
import type { VerdictView } from "@/lib/verdict-view";

const INITIAL: ActionResult = { ok: false, message: "" };
const approve = withPaymentReceipt(approveInvoiceAction);
const reject = withSuccessToast(rejectInvoiceAction);
const giveBack = withSuccessToast(returnInvoiceAction);

/**
 * The card's cost lines (approval total cost TC1, TC2): the invoice, a discount that still applies, the route's fee, what
 * leaves and what the payee receives, read as Approve and pay would pay it now.
 */
function CostBreakdown({ payable }: { payable: WaitingPayable }) {
  const cost = approvalCost(payable);
  return (
    <div className="mt-3 rounded-lg border border-line bg-raised px-3 py-2 text-xs">
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
        {cost.lines.map((line) => (
          <div key={line.label} className="contents">
            <dt className={line.total ? "font-medium text-ink" : "text-ink-3"}>{line.label}</dt>
            <dd className={`text-right tabular-nums ${line.total ? "font-semibold text-ink" : "text-ink-2"}`}>{line.value}</dd>
          </div>
        ))}
      </dl>
      {cost.note && <p className="mt-1.5 text-ink-3">{cost.note}</p>}
    </div>
  );
}

/**
 * What Approve and pay asks before it pays: the amount that will leave, which
 * is the discounted one while an early-payment discount still applies (the
 * same `amountToPay` rule `payInvoice` pays by), naming the discount; a
 * sandbox's payment is simulated, and says so. What the operating wallet lacks
 * comes back from the USYC reserve first, and it says about how much (approval
 * cash R5). One whose earlier transfer is only checked, or looked for first, is
 * never asked as "pay now" (payment exceptions E3).
 */
export function payConfirmTitle(
  payable: Pick<WaitingPayable, "amount" | "counterpartyName" | "discount"> &
    Partial<Pick<WaitingPayable, "currency" | "payeeChain" | "bridgeFeeUsdc" | "payoutRoute" | "fromReserve" | "paymentSent" | "lastAttempt" | "bank">>,
  sandbox: boolean,
  now: Date = new Date()
): string {
  const checking = checkFirstTitle(payActionOf({ paymentSent: payable.paymentSent ?? false, lastAttempt: payable.lastAttempt }), `${fmt(payable.amount)} ${payable.currency ?? "USDC"} to ${payable.counterpartyName}`);
  if (checking) return checking;
  const { amountPaid, discountTaken } = amountToPay(payable.amount, payable.discount, now);
  const discount = discountTaken > 0 && payable.discount ? ` (${payable.discount.pct}% discount through ${utcDay(payable.discount.deadline)})` : "";
  // A payee on another chain: where the money goes, and the fee of the route it takes on top of it (CCTP payouts,
  // review I2; approval payout route P4). A Gateway payout is paid from the Gateway balance.
  const elsewhere = paidAcrossChains(payable.payeeChain) ? ` on ${chainById(payable.payeeChain as string).label}` : "";
  const gateway = payable.payoutRoute === "gateway";
  const fee = !elsewhere
    ? ""
    : payable.bridgeFeeUsdc != null
      ? gateway
        ? ` The Gateway fee, about ${payable.bridgeFeeUsdc} USDC, comes on top, from the Gateway balance.`
        : ` The CCTP fee, about ${payable.bridgeFeeUsdc} USDC, comes on top.`
      : gateway
        ? " A Gateway fee comes on top, from the Gateway balance."
        : " A CCTP fee comes on top.";
  const reserve = payable.fromReserve
    ? ` The operating wallet holds ${payable.fromReserve.operatingUsdc} USDC, so about ${payable.fromReserve.amountUsdc} USDC comes back from the USYC reserve first.`
    : "";
  // A vendor paid to its bank account in Mexico: the USDC leaves, and the vendor receives pesos (bank payouts B12).
  if (payable.bank) {
    return `Pay ${fmt(amountPaid)} USDC to ${payable.counterpartyName}'s bank account in Mexico now?${discount}${sandbox ? " (simulated)" : ""} ${bankQuoteLine(payable.bank)}${reserve}`;
  }
  return `Pay ${fmt(amountPaid)} ${payable.currency ?? "USDC"} to ${payable.counterpartyName}${elsewhere} now?${discount}${sandbox ? " (simulated)" : ""}${fee}${reserve}`;
}

/**
 * What the confirm dialog says will happen when Approve and pay is chosen. A
 * transfer already sent — including one still in flight — is only checked,
 * never sent again; a terminal failure is sent again, as a new transfer;
 * otherwise this is the first attempt. A payment Circle never answered is
 * looked for on Circle first, and sent only once Circle shows none (payment
 * safety R4). A sole approver approving what they
 * entered is told the ledger records that too (sole approver R5).
 */
export function payConfirmDescription(payable: Pick<WaitingPayable, "paymentSent" | "lastAttempt"> & Partial<Pick<WaitingPayable, "payeeChain">>, ownEntry = false): string {
  const own = ownEntry ? ` ${OWN_ENTRY_RECORDED}` : "";
  // A payout to another chain cannot be looked up on Circle: it is asked for again under its own key (review 5).
  if (payable.lastAttempt?.state === "unanswered" && paidAcrossChains(payable.payeeChain)) {
    return `Vestiarion asks Circle for the earlier transfer again under the same payment key, which Circle takes only once: it records it if Circle has it, and only otherwise is this the payment. The ledger records who approved it.${own}`;
  }
  if (payable.lastAttempt?.state === "unanswered") {
    return `Vestiarion looks for the earlier transfer on Circle first: it records it if Circle has it, and sends the payment only once Circle shows none. The ledger records who approved it.${own}`;
  }
  if (payable.paymentSent || payable.lastAttempt?.state === "in_flight" || (payable.lastAttempt?.state === "failed" && payable.lastAttempt.resend === false)) {
    return `Nothing new is sent: Vestiarion checks the transfer already made with Circle, and the ledger records who approved it.${own}`;
  }
  if (payable.lastAttempt?.state === "failed") {
    return `A new transfer starts as soon as you confirm, and the ledger records who approved it.${own}`;
  }
  return `The transfer starts as soon as you confirm, and the ledger records who approved it.${own}`;
}

/** The confirm button of Approve and pay: Pay now, or, where the earlier transfer is checked first, what it does instead (E3). */
export function payConfirmLabel(payable: Pick<WaitingPayable, "paymentSent" | "lastAttempt">): string {
  const action = payActionOf(payable);
  return checksFirst(action) ? CHECK_FIRST_LABEL[action] : "Pay now";
}

/**
 * What the card says of a send Circle never answered: one left `submitting` may still be under way (payment exceptions
 * review 6); a payout to another chain is asked for again under its own key, and Reject and Return wait for Circle's
 * answer (review 5); a first approval of two looks nothing up and sends nothing, the approval that pays it does (T6).
 */
export function unansweredLine(attempt: { sending?: true }, acrossChains: boolean, firstOfTwo: boolean): string {
  const lead = attempt.sending
    ? "Vestiarion started sending this payment and Circle has not answered for over two minutes: it may still be sending, or its answer was lost."
    : "Circle did not answer when this payment was sent, so it may have taken the transfer.";
  if (acrossChains) {
    return `${lead} A payout to another chain cannot be looked up on Circle: Approve and pay asks Circle for it again under the same payment key, which Circle takes only once, so it is never paid twice. Reject and Return wait until Circle has answered.`;
  }
  return firstOfTwo
    ? `${lead} The approval that pays it looks for it on Circle first: it records it if Circle has it, and sends it only once Circle shows none.`
    : `${lead} Approve and pay, Reject and Return look for it on Circle first: Approve and pay records it if Circle has it, and sends it only once Circle shows none.`;
}

/**
 * Whether paying this payable goes against the agent's own judgement, so Approve and pay asks why (capability and
 * reasons R10): the agent flagged it, or held it on one of its rules. Not a payment held for cash, which the agent would
 * have paid, nor one held for a verdict, whose reason the verdict asks for.
 */
export function overridesHold(payable: Pick<WaitingPayable, "status" | "guardrailRule" | "heldForCash" | "heldForVerdict">): boolean {
  if (payable.heldForCash || payable.heldForVerdict) return false;
  return payable.status === "flagged" || payable.guardrailRule !== null;
}

/** The optional reason's field: one line, never required, kept with where it was given and the app's version (R10, R11). */
export const REASON_HINT = "Optional. One line helps Vestiarion's team improve the agent.";

/** The confirmation of an approval that pays nothing yet, the first of two (two approvals T8). */
export function approveFirstTitle(payable: Pick<WaitingPayable, "amount" | "counterpartyName"> & Partial<Pick<WaitingPayable, "currency">>): string {
  return `Approve paying ${fmt(payable.amount)} ${payable.currency ?? "USDC"} to ${payable.counterpartyName}?`;
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
 * Above the workspace's figure for two approvals (`payable.twoApprovals`), the card says who approved it so far, by
 * the email in `memberEmails`, and Approve and pay reads Approve until the viewer's approval would be the second one,
 * which pays it. Whoever gave the first approval cannot give the second (two approvals T8).
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
  memberEmails = {},
  verdict,
  exception,
  viewerEmail,
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
  /** The emails of the members who approved a payment above the figure for two approvals, by user id. */
  memberEmails?: Record<string, string>;
  /** A person's verdict on the agent's decision, in shadow mode: given, or to give in place of approving it (shadow mode S4). */
  verdict?: VerdictView;
  /** Its priority, the day it must be decided by and who can act on it (deal cash readiness E1-E3). */
  exception?: ExceptionFacts;
  /** The viewer's own email, named "you" among who can act. */
  viewerEmail?: string | null;
}) {
  const unfinished = payable.status === "processing" && payable.reclaimable;
  // Above the figure for two approvals: one person, sole approver or not, never pays it alone (two approvals T5).
  const two = payable.twoApprovals ?? null;
  const ownEntry = !two && soleApprover && payable.createdBy === viewerId;
  // A sole approver paying the first payment to an address they gave, asked for or confirmed (new payee check N4).
  const ownAddress = !two && soleApprover && leftOutForAddress(payable, viewerId);
  const status = unfinished ? UNFINISHED : STATUS[payable.status];
  // Agree and pay pays it now or not at all: where this person may not, or their approval would only be the first of
  // two, they agree without paying (shadow mode review I2).
  const verdictPayBlocked =
    payBlockedReason(payable, viewerId, ownEntry, ownAddress) ??
    (two && !two.approvals.some((approval) => approval.by !== viewerId) ? "A second person's approval pays it" : null);
  const processing = payable.status === "processing" && !payable.reclaimable;
  const canAddDetails =
    canEdit &&
    payable.status !== "processing" &&
    !payable.paymentSent &&
    payable.lastAttempt?.state !== "in_flight" &&
    (payable.poReference === null || !payable.goodsReceived);

  return (
    <Card asChild tone={payable.status === "flagged" ? "refused" : processing ? "agent" : "held"}>
      <article id={approvalAnchor(payable.id)} className="scroll-mt-4">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <CardTitle className="truncate">{payable.counterpartyName}</CardTitle>
            <p className="text-sm text-ink-2">
              Due {utcDay(payable.dueDate)}
              {payable.decidedAt && <span className="text-ink-3"> · stopped {utcMinute(payable.decidedAt)}</span>}
            </p>
            {exception && !processing && <ExceptionLine facts={exception} viewerEmail={viewerEmail} className="pt-0.5" />}
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
          {payable.bank ? (
            <div className="mt-2 space-y-0.5 text-xs">
              <p className="text-ink-2">{bankAccountLine(payable.bank)}</p>
              <p className="text-ink-3">{bankQuoteLine(payable.bank)}</p>
            </div>
          ) : (
            <p className="mt-2 min-w-0 text-xs text-ink-3">
              Pays to{" "}
              {payable.address ? <span className="font-mono break-all text-ink-2">{payable.address}</span> : "no address set"}
              {paidAcrossChains(payable.payeeChain) && ` on ${chainById(payable.payeeChain as string).label}`}
            </p>
          )}
          {/* What Approve and pay would cost, before anyone approves (approval total cost TC1): not for a payment already sent. */}
          {!payable.bank && !processing && !payable.paymentSent && payable.lastAttempt?.state !== "in_flight" && <CostBreakdown payable={payable} />}
          {!payable.bank && payToDiffers(payable.documentPayTo, payable.address) && (
            // The invoice asked to be paid somewhere else (invoice pay-to hold IP3): Approve and pay still pays the address on file.
            <Callout tone="held" className="mt-2">
              <span className="break-all">
                {invoiceAskedFor(payable.documentPayTo as string, payable.address)}
              </span>
            </Callout>
          )}
          {payable.payeeFrozen && (
            // The payee's contact said they did not make the change to its address (address change check AC5).
            <Callout tone="refused" className="mt-2">
              {payable.counterpartyName} is frozen: their contact on file said they did not make the change to this address. Approve and pay is refused until an
              owner or admin checks with them and unfreezes them on Counterparties.
            </Callout>
          )}
          {two && <p className="mt-2 text-sm text-ink-2">{twoApprovalsLine(two, viewerId, memberEmails)}</p>}
          {two && canDecide && two.approvers < 2 && (
            <Callout tone="held" className="mt-2">
              {onlyApproverOfTwo(two.above)}
            </Callout>
          )}
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
          {payable.paymentSent && payable.lastAttempt?.state !== "in_flight" && payable.lastAttempt?.state !== "unanswered" && (
            <p className="mt-2 text-sm text-ink-2">A payment was already sent; Approve and pay records it.</p>
          )}
          {canDecide && !processing && ownEntry && payable.riskLevel !== "high" && <p className="mt-2 text-sm text-ink-2">{OWN_INVOICE_NOTE}</p>}
          {canDecide && !processing && (
            <ApprovalGuidance
              orgSlug={orgSlug}
              payable={payable}
              // Above the figure, whoever entered it gives one of the two approvals when too few others can.
              selfEntered={payable.createdBy === viewerId && !ownEntry && !(two && mayApproveNow(two, viewerId))}
              canEdit={canEdit}
            />
          )}
          {payable.lastAttempt?.state === "failed" && (
            <Callout tone="refused" className="mt-2">
              The last payment attempt failed: {payable.lastAttempt.reason}.{" "}
              {payable.lastAttempt.resend === false
                ? "Approving sends nothing new: check with Circle whether it was minted, and reject or return the invoice if it was not."
                : "Approving sends a new transfer. Fix what Circle names before approving, such as adding USDC to the operating wallet."}
            </Callout>
          )}
          {payable.lastAttempt?.state === "in_flight" && (
            <Callout tone="held" className="mt-2">
              The payment is still in flight on {homeChain(networkOfChain(payable.payeeChain)).label}. It cannot be rejected or returned until Circle settles it; approving checks it again.
            </Callout>
          )}
          {payable.lastAttempt?.state === "unanswered" && (
            <Callout tone="held" className="mt-2">
              {unansweredLine(payable.lastAttempt, paidAcrossChains(payable.payeeChain), Boolean(two && !two.approvals.some((approval) => approval.by !== viewerId)))}
            </Callout>
          )}
        </CardContent>
        {processing ? (
          <CardFooter>
            <p className="text-sm text-ink-2">Being decided by someone else right now.</p>
          </CardFooter>
        ) : canDecide && verdict && verdict.open && payable.heldForVerdict ? (
          // Held in shadow mode for a person to agree: the verdict is the decision (shadow mode S4).
          <CardFooter>
            <VerdictControl orgSlug={orgSlug} view={verdict} payBlocked={verdictPayBlocked} size="touch" />
          </CardFooter>
        ) : canDecide ? (
          <>
            {verdict?.given && (
              <CardFooter>
                <VerdictControl orgSlug={orgSlug} view={verdict} size="touch" />
              </CardFooter>
            )}
            <Decisions orgSlug={orgSlug} payable={payable} viewerId={viewerId} sandbox={sandbox} ownEntry={ownEntry} ownAddress={ownAddress} canAddDetails={canAddDetails} />
          </>
        ) : exception && exception.owners.length > 0 ? (
          // Someone who cannot decide it still has a next step: who to ask (deal cash readiness E5).
          <CardFooter>
            <p className="text-sm text-ink-2">
              Ask {exception.owners.slice(0, 2).join(" or ")}
              {exception.owners.length > 2 ? `, or one of the ${exception.owners.length - 2} others who can,` : ""} to decide it.
            </p>
          </CardFooter>
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

/**
 * Why the viewer may not pay this payable now, or null: they entered it, or gave its new payee's address, and are not
 * the only one who may approve payments (sole approver R5, new payee check N4); it needs two approvals and they gave the
 * first, or no second person can (two approvals T5); or it is screened high risk. The card's Approve and pay and its
 * verdict's Agree and pay follow it alike (shadow mode review I2).
 */
export function payBlockedReason(payable: WaitingPayable, viewerId: string, ownEntry: boolean, ownAddress: boolean): string | null {
  const two = payable.twoApprovals ?? null;
  const viewerApproved = two?.approvals.some((approval) => approval.by === viewerId) ?? false;
  const willPay = !two || two.approvals.some((approval) => approval.by !== viewerId);
  return two
    ? two.approvers < 2
      ? "Needs a second approver"
      : viewerApproved && !willPay
        ? "You approved it"
        : !mayApproveNow(two, viewerId)
          ? payable.createdBy === viewerId
            ? "You created this invoice"
            : gaveAddressReason(payable, viewerId)
          : payable.riskLevel === "high"
            ? "Screened high risk"
            : null
    : payable.createdBy === viewerId && !ownEntry
      ? "You created this invoice"
      : leftOutForAddress(payable, viewerId) && !ownAddress
        ? gaveAddressReason(payable, viewerId)
        : payable.riskLevel === "high"
          ? "Screened high risk"
          : null;
}

/**
 * Whether the viewer may not pay the first payment to this address alone (N4): they gave it or asked for it; or, for one
 * no member answers for alone, they confirmed it, or no other member has confirmed it yet.
 */
function leftOutForAddress(payable: WaitingPayable, viewerId: string): boolean {
  if (payable.firstPaymentUnanswered) {
    const confirmers = payable.firstPaymentConfirmers ?? [];
    return confirmers.length === 0 || confirmers.includes(viewerId);
  }
  return payable.firstPaymentAddressBy === viewerId;
}

/** Why the viewer may not pay the first payment to this address alone, as Approve and pay refuses them (N4). */
function gaveAddressReason(payable: WaitingPayable, viewerId: string): string {
  if (payable.firstPaymentUnanswered) {
    return payable.firstPaymentConfirmers?.includes(viewerId) ? "You confirmed this address" : "Another member must confirm this address first";
  }
  // An address a GitHub bounty asked for is one no member answers for alone, answered above.
  return payable.firstPaymentVia === "payee_link" ? "You asked for this address with a payee link" : "You gave this payee's address";
}

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
  // Why the person goes against the agent, asked in the confirmation itself and never required (R10). Each reaches its
  // form through a hidden field, since the dialog renders outside it.
  const [payReason, setPayReason] = useState("");
  const [returnReason, setReturnReason] = useState("");
  // Not where Approve and pay reads, or looks for, an earlier transfer first: that pays nothing new (payment exceptions E3).
  const askWhyPaid = overridesHold(payable) && !checksFirst(payActionOf(payable));
  // Both forms report in one place: whichever was submitted last.
  const [last, setLast] = useState<"approve" | "return" | null>(null);
  const shown = last === "approve" ? approveForm.state : last === "return" ? returnForm.state : INITIAL;

  // Above the figure for two approvals: the viewer's approval pays it only when someone else approved it first (T8).
  const two = payable.twoApprovals ?? null;
  const willPay = !two || two.approvals.some((approval) => approval.by !== viewerId);
  const blocked = payBlockedReason(payable, viewerId, ownEntry, ownAddress);
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
          {askWhyPaid && <input type="hidden" name="reason" value={payReason} />}
        </form>
        <ConfirmDialog
          formId={approveId}
          tone="primary"
          trigger={
            <Button
              size="touch"
              icon={<Banknote />}
              loading={approveForm.pending}
              disabled={blocked !== null}
              aria-describedby={blocked ? blockedId : undefined}
              className="max-sm:w-full"
            >
              {willPay ? "Approve and pay" : "Approve"}
            </Button>
          }
          title={willPay ? payConfirmTitle(payable, sandbox) : approveFirstTitle(payable)}
          description={
            willPay ? `${payConfirmDescription(payable, ownEntry)}${two ? ` ${SECOND_APPROVAL_PAYS}` : ""}` : two ? approveFirstDescription(two.above) : ""
          }
          confirmLabel={willPay ? payConfirmLabel(payable) : "Approve"}
          {...(askWhyPaid
            ? {
                children: (
                  <Field id={`${approveId}-reason`} label="Why pay it anyway?" optional description={REASON_HINT}>
                    <Input value={payReason} onChange={(event) => setPayReason(event.target.value)} maxLength={280} autoComplete="off" />
                  </Field>
                ),
              }
            : {})}
          // Approved and being sent, or the earlier transfer being checked, until the payment's confirmation replaces it
          // (payment confirmation; payment exceptions E3).
          onConfirm={
            willPay
              ? () =>
                  paymentSendingToast(
                    paymentToastId(payable.id),
                    {
                      amount: amountToPay(payable.amount, payable.discount, new Date()).amountPaid,
                      currency: payable.currency ?? "USDC",
                      payee: payable.counterpartyName,
                      decidedBy: "approval",
                    },
                    payActionOf(payable)
                  )
              : undefined
          }
        />
        {canAddDetails && <AddDetailsDialog orgSlug={orgSlug} payable={payable} size="touch" />}
        {(!payable.paymentSent || payable.lastAttempt?.state === "unanswered") && payable.lastAttempt?.state !== "in_flight" && (
          <>
            <RejectDialog orgSlug={orgSlug} payable={payable} />
            <form id={returnId} className="contents" {...returnForm.formProps} onSubmit={submitting("return", returnForm.formProps.onSubmit)}>
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="invoiceId" value={payable.id} />
              <input type="hidden" name="reason" value={returnReason} />
            </form>
            <ConfirmDialog
              formId={returnId}
              tone="primary"
              trigger={
                <Button size="touch" variant="ghost" icon={<Undo2 />} loading={returnForm.pending}>
                  Return to agent
                </Button>
              }
              title={`Return ${payable.counterpartyName}'s invoice to the agent?`}
              description="It goes back to pending, and the agent's next cycle decides it again."
              confirmLabel="Return to agent"
            >
              <Field id={`${returnId}-reason`} label="Why return it?" optional description={REASON_HINT}>
                <Input value={returnReason} onChange={(event) => setReturnReason(event.target.value)} maxLength={280} autoComplete="off" />
              </Field>
            </ConfirmDialog>
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
          <Button asChild size="touch" variant="secondary" className="mt-2">
            <Link href={orgHref(orgSlug, counterpartyPath(payable.counterpartyId))}>Review screening</Link>
          </Button>
        )}
      </Callout>
    );
  }
  if (!selfEntered) return null;
  const rule = payable.guardrailRule ?? (payable.heldForCash ? CASH_SHORTFALL : payable.heldForVerdict ? SHADOW_VERDICT : null);
  const resumes = agentResumes(rule);
  const fix = ruleNextStep(rule, { id: payable.counterpartyId, name: payable.counterpartyName })?.fix ?? null;
  return (
    <Callout tone="held" title="You entered this invoice" className="mt-3">
      <p>{SELF_APPROVAL_EXPLAINED}</p>
      {resumes && <p className="mt-1.5">{resumes}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {fix && canEdit && (
          <Button asChild size="touch" variant="secondary">
            <Link href={orgHref(orgSlug, fix.path)}>{fix.label}</Link>
          </Button>
        )}
        <Button asChild size="touch" variant="ghost">
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
        <Button size="touch" variant="danger" icon={<X />}>
          Reject
        </Button>
      </DialogTrigger>
      <DialogContent title={`Reject ${payable.counterpartyName}'s invoice?`} description="The invoice is not paid. The reason is kept in the ledger, not on the invoice.">
        <form {...formProps} className="grid gap-5">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="invoiceId" value={payable.id} />
          <Field id={reasonId} label="Why reject it?" optional description={`${REASON_HINT} At most 280 characters.`}>
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
