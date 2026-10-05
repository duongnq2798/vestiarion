"use client";

import { useCallback, useState } from "react";
import { updateCounterpartyPurchaseOrdersAction, type IntakeActionResult } from "@/app/actions/intake";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";

const INITIAL: IntakeActionResult = { ok: false, message: "" };
const update = withSuccessToast(updateCounterpartyPurchaseOrdersAction);

/** What a counterparty's card says about its purchase orders. */
export function purchaseOrdersLabel(required: boolean): string {
  return required ? "Needed before the agent pays" : "Not needed · goods received still is";
}

/**
 * "Change" beside whether a counterparty needs purchase orders, for owners and admins (three-way match design M2).
 * Every counterparty needs one by default; one marked paid without them is paid on the goods or services received
 * alone. The action writes the setting and records who changed it (src/lib/counterparty-purchase-orders.ts).
 */
export default function CounterpartyPurchaseOrdersEdit({
  orgSlug,
  counterparty,
}: {
  orgSlug: string;
  counterparty: { id: string; name: string; purchaseOrderRequired: boolean };
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { state, formProps } = useActionForm(update, INITIAL, { onSuccess: close });
  const required = counterparty.purchaseOrderRequired;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="link" className="text-xs" aria-label={`Change whether ${counterparty.name} needs purchase orders`}>
          Change
        </Button>
      </DialogTrigger>
      <DialogContent
        title={required ? `Pay ${counterparty.name} without purchase orders?` : `Require purchase orders from ${counterparty.name}?`}
        description={
          required
            ? "The agent will pay this counterparty's invoices with no purchase order on file. It still needs the goods or services marked received, and every other check stays. Invoices waiting only for a purchase order are decided again within a minute."
            : "The agent will ask for a purchase order before it pays or schedules any of this counterparty's invoices, as it does for every counterparty by default. A payment already scheduled without one waits for the details on its day."
        }
      >
        <form {...formProps} className="grid gap-5">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="counterpartyId" value={counterparty.id} />
          <input type="hidden" name="purchaseOrderRequired" value={required ? "false" : "true"} />
          <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <SubmitButton pendingLabel="Saving…">{required ? "Pay without purchase orders" : "Require purchase orders"}</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
