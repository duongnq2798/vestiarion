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

const INITIAL: IntakeActionResult = { ok: false, message: "" };
const update = withSuccessToast(updateCounterpartyNoticeEmailAction);

/**
 * "Edit" beside where a counterparty's payment notices go, for owners and admins (payment notices R1). Empty turns
 * them off.
 */
export default function CounterpartyNoticeEmailEdit({
  orgSlug,
  counterparty,
}: {
  orgSlug: string;
  counterparty: { id: string; name: string; noticeEmail: string | null };
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { state, formProps } = useActionForm(update, INITIAL, { onSuccess: close });
  const fieldId = `notice-email-${counterparty.id}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="link" className="text-xs" aria-label={`Edit where ${counterparty.name}'s payment notices go`}>
          {counterparty.noticeEmail ? "Edit" : "Add"}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`${counterparty.name}'s payment notices`}
        description="Each time a payment to it is confirmed on Arc testnet, Vestiarion emails this address the amount, what it is for and the transaction. Leave it empty to send none."
      >
        <form {...formProps} className="grid gap-5">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="counterpartyId" value={counterparty.id} />
          <Field id={fieldId} label="Email for payment notices" optional>
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
