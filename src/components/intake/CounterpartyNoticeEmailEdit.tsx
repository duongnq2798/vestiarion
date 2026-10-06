"use client";

import { useCallback, useState } from "react";
import { updateCounterpartyNoticeEmailAction, type IntakeActionResult } from "@/app/actions/intake";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";
import { networkProfile, type Network } from "@/lib/network";

const INITIAL: IntakeActionResult = { ok: false, message: "" };
const update = withSuccessToast(updateCounterpartyNoticeEmailAction);

/**
 * "Edit" beside a counterparty's billing email, for owners and admins: a payee's payment notices go to it (payment
 * notices R1), and a client's reminders (collections R8). Empty turns
 * them off.
 */
/** What the billing email is for: a client's reminders, or a payee's notices of payments on the workspace's network. */
export function noticeEmailDescription(role: string | undefined, network: Network): string {
  return role === "client"
    ? "When you turn on reminders for one of its invoices on AP / AR, the agent emails them here, with the pay link. Leave it empty to send none."
    : `Each time a payment to it is confirmed on ${networkProfile(network).label}, Vestiarion emails this address the amount, what it is for and the transaction. Leave it empty to send none.`;
}

export default function CounterpartyNoticeEmailEdit({
  orgSlug,
  counterparty,
  network,
}: {
  orgSlug: string;
  counterparty: { id: string; name: string; role?: string; noticeEmail: string | null };
  /** The workspace's network, named in the description (mainnet copy C1). */
  network: Network;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { state, formProps } = useActionForm(update, INITIAL, { onSuccess: close });
  const fieldId = `notice-email-${counterparty.id}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="link" className="text-xs" aria-label={`Edit ${counterparty.name}'s billing email`}>
          {counterparty.noticeEmail ? "Edit" : "Add"}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`${counterparty.name}'s billing email`}
        description={noticeEmailDescription(counterparty.role, network)}
      >
        <form {...formProps} className="grid gap-5">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="counterpartyId" value={counterparty.id} />
          <Field id={fieldId} label="Billing email" optional>
            <Input name="noticeEmail" type="email" maxLength={254} defaultValue={counterparty.noticeEmail ?? ""} autoComplete="off" placeholder="accounts@example.com" />
          </Field>
          <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
