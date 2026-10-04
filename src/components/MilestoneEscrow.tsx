"use client";

import { LockKeyhole, Undo2 } from "lucide-react";
import { useState } from "react";
import { lockMilestoneAction, refundMilestoneAction, type EscrowActionResult } from "@/app/actions/escrow";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { Hash } from "@/components/vx/Primitives";
import { arcTxUrl } from "@/lib/payee-chains";

const INITIAL: EscrowActionResult = { ok: false, message: "" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface MilestoneHold {
  state: "funded" | "released" | "refunded";
  /** The address the hold pays; null for one recorded before it was kept. */
  payee?: string | null;
  refundAfter: string;
  amount: number;
  fundTxHash: string | null;
  releaseTxHash: string | null;
  refundTxHash: string | null;
}

/** "31 Oct 2026", the same on the server and in every browser. */
function day(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function TxLink({ hash }: { hash: string | null }) {
  return hash ? <Hash value={hash} href={arcTxUrl(hash)} /> : null;
}

/**
 * A milestone's escrow, under its card on Contractors (docs/superpowers/specs/2026-10-01-milestone-escrow-design.md
 * E3, E6): for an owner or admin, the form that locks an unlocked milestone until a refund date; for anyone,
 * what became of its hold. The page makes the request id and the default date, so the server's markup and the
 * browser's agree; a new id is made after a lock, and after a step Circle failed.
 */
export function MilestoneEscrow({
  orgSlug,
  milestoneId,
  requestId: initialRequestId,
  defaultRefundDate,
  minRefundDate,
  maxRefundDate,
  escrowReady,
  canManage,
  paid,
  refundable,
  payee,
  amount,
  lockable,
  hold,
}: {
  orgSlug: string;
  milestoneId: string;
  requestId: string;
  defaultRefundDate: string;
  /** The first and last refund dates the app accepts: tomorrow, and a year from today (review M4). */
  minRefundDate: string;
  maxRefundDate: string;
  escrowReady: boolean;
  canManage: boolean;
  paid: boolean;
  /** The hold's refund date has come: decided on the server, so the server's markup and the browser's agree. */
  refundable: boolean;
  /** The contractor's address, which a lock would pay for good (review C1). */
  payee: string | null;
  amount: number;
  /** Whether it can be locked now: not yet verified, for a contractor with a confirmed Arc testnet address. */
  lockable: boolean;
  hold: MilestoneHold | null;
}) {
  const [requestId, setRequestId] = useState(initialRequestId);
  const renew = (result: EscrowActionResult) => (result.ok || result.renew) && setRequestId(crypto.randomUUID());
  const { state, formProps } = useActionForm(lockMilestoneAction, INITIAL, { toastOnSuccess: true, onResult: renew });
  const refund = useActionForm(refundMilestoneAction, INITIAL, { toastOnSuccess: true, onResult: renew });

  if (hold) {
    // Whatever the milestone's status: the refund reads the chain, which says whether the hold is still there (review I1).
    const canRefund = hold.state === "funded" && refundable && canManage;
    const holdPayee = hold.payee ?? payee;
    return (
      <div className="mt-2 flex flex-col gap-2 px-1 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <LockKeyhole className="size-4 text-ink-3" aria-hidden />
          {hold.state === "funded" ? (
            <>
              {hold.amount} USDC locked in escrow{holdPayee ? ` for ${short(holdPayee)}` : ""} until {day(hold.refundAfter)}
              <TxLink hash={hold.fundTxHash} />
            </>
          ) : hold.state === "released" ? (
            <>
              Released from escrow to the contractor
              <TxLink hash={hold.releaseTxHash} />
            </>
          ) : (
            <>
              Refunded from escrow to this workspace
              <TxLink hash={hold.refundTxHash} />
            </>
          )}
        </p>
        {canRefund && (
          <form {...refund.formProps} className="flex flex-col gap-1 sm:items-end">
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <input type="hidden" name="milestoneId" value={milestoneId} />
            <input type="hidden" name="requestId" value={requestId} />
            <SubmitButton variant="secondary" size="sm" icon={<Undo2 />} pendingLabel="Refunding…">
              Refund from escrow
            </SubmitButton>
            <FormMessage tone="error">{refund.state.ok ? null : refund.state.message}</FormMessage>
          </form>
        )}
      </div>
    );
  }
  if (!escrowReady || !canManage || paid) return null;
  if (!lockable || !payee) {
    return (
      <p className="mt-2 px-1 text-xs text-ink-3">
        This milestone cannot be locked in escrow now. It can be locked while it is not yet verified, for a contractor with a confirmed Arc testnet address.
      </p>
    );
  }

  return (
    <form {...formProps} className="mt-2 flex flex-col gap-3 rounded-xl border border-line bg-surface px-4 py-3 sm:flex-row sm:items-end sm:justify-between">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="milestoneId" value={milestoneId} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="min-w-0 space-y-2">
        <p className="break-all text-sm text-ink-2">
          Locks {amount} USDC for {payee}, the contractor&apos;s address. Only a release to it, or a refund from the date, can move it.
        </p>
        <Field id={`refund-after-${milestoneId}`} label="Refundable to this workspace from">
          <Input type="date" name="refundAfter" defaultValue={defaultRefundDate} min={minRefundDate} max={maxRefundDate} required className="sm:w-48" />
        </Field>
      </div>
      <div className="flex flex-col gap-2 sm:items-end">
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
        <SubmitButton variant="secondary" icon={<LockKeyhole />} pendingLabel="Locking…" className="shrink-0">
          Lock in escrow
        </SubmitButton>
      </div>
    </form>
  );
}
