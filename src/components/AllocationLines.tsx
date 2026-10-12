"use client";

import { Receipt, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { applyPaymentAction, reverseAllocationAction } from "@/app/actions/allocations";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { Hash, Money } from "@/components/vx/Primitives";
import { REASON_MAX } from "@/lib/allocations/model";
import type { AppliedLineView, ReceivableView } from "@/lib/allocations/view";
import { utcDay } from "@/lib/copy";
import type { Network } from "@/lib/network";
import { homeChain } from "@/lib/payee-chains";

/**
 * The payments and fees applied to one receivable, on its card (docs/superpowers/specs/2026-10-12-allocations-design.md
 * L7, L8, L11): what was received and what is still owed, each payment with its transaction, each fee with its reason,
 * and, for an owner or admin, Reverse (a correction appended, with a reason) and Record a fee beside a payment.
 */

type Note = { tone: "neutral" | "error"; text: string } | null;

const shortAddress = (address: string) => (address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);

export function AllocationLines({
  orgSlug,
  network,
  view,
  label,
  canWrite,
}: {
  orgSlug: string;
  network: Network;
  view: ReceivableView;
  /** The receivable as a person names it: its memo, or its due day. */
  label: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = useState<Note>(null);
  const done = (result: { ok: boolean; message: string }) => {
    setNote({ tone: result.ok ? "neutral" : "error", text: result.message });
    router.refresh();
  };

  return (
    <div className="grid gap-2" data-allocation-lines={view.invoiceId}>
      <p className="text-sm font-medium text-ink">Payments applied</p>
      <p className="text-xs leading-5 text-ink-2">
        Received <Money value={view.paid} token={view.currency} /> of <Money value={view.amount} token={view.currency} />
        {view.fees > 0 && (
          <>
            , and <Money value={view.fees} token={view.currency} /> recorded as fees
          </>
        )}
        .{" "}
        {view.outstanding > 0 ? (
          <>
            <Money value={view.outstanding} token={view.currency} /> still owed.
          </>
        ) : (
          "Nothing is owed."
        )}
      </p>
      <ul className="grid gap-1.5">
        {view.lines.map((line) => (
          <li key={line.allocationId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2 text-xs">
            <LineWords line={line} network={network} />
            {canWrite && <ReverseLine orgSlug={orgSlug} line={line} label={label} onDone={done} />}
          </li>
        ))}
      </ul>
      {canWrite && view.canRecordFee && <RecordFee orgSlug={orgSlug} view={view} label={label} onDone={done} />}
      {note && <FormMessage tone={note.tone}>{note.text}</FormMessage>}
    </div>
  );
}

function LineWords({ line, network }: { line: AppliedLineView; network: Network }) {
  if (line.kind === "fee") {
    return (
      <span className="min-w-0 text-ink-2">
        <Money value={line.amount} token={line.currency} className="font-medium text-ink" /> fee: {line.reason}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-ink-2">
      <Money value={line.amount} token={line.currency} className="font-medium text-ink" />
      <span>
        received {line.receivedAt ? utcDay(line.receivedAt) : ""}
        {line.from ? ` from ${shortAddress(line.from)}` : ""}
        {line.byAgent ? ", applied by the agent" : ""}
      </span>
      {line.txHash && <Hash value={line.txHash} href={`${homeChain(network).explorerTx}${line.txHash}`} />}
    </span>
  );
}

function ReverseLine({ orgSlug, line, label, onDone }: { orgSlug: string; line: AppliedLineView; label: string; onDone: (result: { ok: boolean; message: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    startTransition(async () => {
      const result = await reverseAllocationAction(orgSlug, { allocationId: line.allocationId, reason });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      onDone(result);
    });
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" icon={<Undo2 />}>
          Reverse
        </Button>
      </DialogTrigger>
      <DialogContent
        title={line.kind === "fee" ? `Reverse the fee on ${label}` : `Reverse this payment on ${label}`}
        description="Nothing is deleted: a correction is added, and the audit log keeps both. What it applied is owed again, and the payment can be applied elsewhere."
      >
        <form onSubmit={submit} className="grid gap-4">
          <Field id={`reverse-${line.allocationId}`} label="Why" description={`At most ${REASON_MAX} characters.`}>
            <Textarea name="reason" required maxLength={REASON_MAX} rows={2} placeholder="Such as: applied to the wrong invoice" />
          </Field>
          {error && <FormMessage tone="error">{error}</FormMessage>}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button type="submit" loading={pending}>
              Reverse
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RecordFee({ orgSlug, view, label, onDone }: { orgSlug: string; view: ReceivableView; label: string; onDone: (result: { ok: boolean; message: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fee = { invoiceId: view.invoiceId, amount: String(form.get("amount") ?? ""), reason: String(form.get("reason") ?? "") };
    startTransition(async () => {
      const result = await applyPaymentAction(orgSlug, { paymentId: null, version: null, lines: [], fees: [fee] });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      onDone(result);
    });
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" icon={<Receipt />} className="justify-self-start">
          Record a fee
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Record a fee on ${label}`}
        description="A difference you will not collect, such as a transfer fee: applied to the invoice, never counted as paid by the customer."
      >
        <form onSubmit={submit} className="grid gap-4">
          <Field id={`fee-${view.invoiceId}-amount`} label="Fee" description={`Up to what is still owed: ${view.outstanding.toFixed(2)} ${view.currency}.`}>
            <Input name="amount" required inputMode="decimal" placeholder="0.00" />
          </Field>
          <Field id={`fee-${view.invoiceId}-reason`} label="Why it is a fee">
            <Input name="reason" required maxLength={REASON_MAX} placeholder="Such as a transfer fee the client's bank took" />
          </Field>
          {error && <FormMessage tone="error">{error}</FormMessage>}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button type="submit" loading={pending}>
              Record the fee
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
