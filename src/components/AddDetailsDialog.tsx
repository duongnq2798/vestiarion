"use client";

import { ClipboardCheck } from "lucide-react";
import { useCallback, useState } from "react";
import { addInvoiceDetailsAction } from "@/app/actions/approvals";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm, type ActionResult } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";
import type { WaitingPayable } from "@/lib/agent/approvals";

const INITIAL: ActionResult = { ok: false, message: "" };
const addDetails = withSuccessToast(addInvoiceDetailsAction);

/**
 * Adds what the payable is missing: its purchase order, when it has none, and its goods or services marked received,
 * when they are not. Only the missing fields are offered; what is on file is shown, never edited (complete held
 * invoice R2).
 */
export function AddDetailsDialog({
  orgSlug,
  payable,
  variant = "secondary",
}: {
  orgSlug: string;
  payable: Pick<WaitingPayable, "id" | "counterpartyName" | "poReference" | "goodsReceived">;
  /** Secondary beside Approve and pay; primary where adding details is the one thing to do (Invoices). */
  variant?: "primary" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { state, formProps } = useActionForm(addDetails, INITIAL, { resetOnSuccess: true, onSuccess: close });
  const poId = `details-po-${payable.id}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={variant} icon={<ClipboardCheck />}>
          Add details
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Add details to ${payable.counterpartyName}'s invoice`}
        description="The agent pays an invoice on its own only with a purchase order on file and the goods or services received. Add what is missing: the agent decides it again at its next cycle, and the ledger records what you added."
      >
        <form {...formProps} className="grid gap-5">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="invoiceId" value={payable.id} />
          {payable.poReference === null ? (
            <Field id={poId} label="PO reference" optional={!payable.goodsReceived}>
              <Input name="poReference" maxLength={100} placeholder="PO-100" />
            </Field>
          ) : (
            <p className="text-sm text-ink-2">
              PO reference <span className="font-mono text-ink">{payable.poReference}</span> is on file.
            </p>
          )}
          {payable.goodsReceived ? (
            <p className="text-sm text-ink-2">The goods or services are marked received.</p>
          ) : (
            <Checkbox name="goodsReceived" label="Goods or services received" description="Tick it only if you received them." />
          )}
          <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <SubmitButton pendingLabel="Adding…">Add details</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
