"use client";

import { LockKeyhole, Undo2 } from "lucide-react";
import { useState } from "react";
import { lockMilestoneAction, refundMilestoneAction, type EscrowActionResult } from "@/app/actions/escrow";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { explorerTx, Hash } from "@/components/vx/Primitives";

const INITIAL: EscrowActionResult = { ok: false, message: "" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface MilestoneHold {
  state: "funded" | "released" | "refunded";
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

function TxLink({ hash }: { hash: string | null }) {
  return hash ? <Hash value={hash} href={explorerTx(hash)} /> : null;
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
  escrowReady,
  canManage,
  paid,
  refundable,
  hold,
}: {
  orgSlug: string;
  milestoneId: string;
  requestId: string;
  defaultRefundDate: string;
  escrowReady: boolean;
  canManage: boolean;
  paid: boolean;
  /** The hold's refund date has come: decided on the server, so the server's markup and the browser's agree. */
  refundable: boolean;
  hold: MilestoneHold | null;
}) {
  const [requestId, setRequestId] = useState(initialRequestId);
  const renew = (result: EscrowActionResult) => (result.ok || result.renew) && setRequestId(crypto.randomUUID());
  const { state, formProps } = useActionForm(lockMilestoneAction, INITIAL, { toastOnSuccess: true, onResult: renew });
  const refund = useActionForm(refundMilestoneAction, INITIAL, { toastOnSuccess: true, onResult: renew });

  if (hold) {
    const canRefund = hold.state === "funded" && refundable && canManage && !paid;
    return (
      <div className="mt-2 flex flex-col gap-2 px-1 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <LockKeyhole className="size-4 text-ink-3" aria-hidden />
          {hold.state === "funded" ? (
            <>
              {hold.amount} USDC locked in escrow until {day(hold.refundAfter)}
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

  return (
    <form {...formProps} className="mt-2 flex flex-col gap-3 rounded-xl border border-line bg-surface px-4 py-3 sm:flex-row sm:items-end sm:justify-between">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="milestoneId" value={milestoneId} />
      <input type="hidden" name="requestId" value={requestId} />
      <Field id={`refund-after-${milestoneId}`} label="Refundable to this workspace from">
        <Input type="date" name="refundAfter" defaultValue={defaultRefundDate} required className="sm:w-48" />
      </Field>
      <div className="flex flex-col gap-2 sm:items-end">
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
        <SubmitButton variant="secondary" icon={<LockKeyhole />} pendingLabel="Locking…" className="shrink-0">
          Lock in escrow
        </SubmitButton>
      </div>
    </form>
  );
}
