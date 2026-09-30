"use client";

import { BadgeCheck, PencilLine } from "lucide-react";
import { useCallback, useState } from "react";
import {
  confirmCounterpartyAddressAction,
  updateCounterpartyAddressAction,
  type IntakeActionResult,
} from "@/app/actions/intake";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";

const INITIAL: IntakeActionResult = { ok: false, message: "" };
const update = withSuccessToast(updateCounterpartyAddressAction);
const confirm = withSuccessToast(confirmCounterpartyAddressAction);

export interface CounterpartyAddressProps {
  orgSlug: string;
  counterparty: { id: string; name: string; address: string | null };
  /** When the address was changed, while no one has confirmed it; null otherwise. */
  unconfirmedSince: string | null;
  canWrite: boolean;
  canConfirm: boolean;
}

/**
 * A counterparty's payment address on its card: shown, edited by owners and
 * admins, and, after a change, confirmed by anyone who may approve payments
 * (spec 2026-09-30-counterparty-address-edit). Until then the agent holds
 * every payment to it for a person.
 */
export default function CounterpartyAddress({ orgSlug, counterparty, unconfirmedSince, canWrite, canConfirm }: CounterpartyAddressProps) {
  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        {counterparty.address ? (
          <p className="min-w-0 truncate font-mono text-[0.7rem] text-ink-3" title={counterparty.address}>
            {counterparty.address}
          </p>
        ) : (
          <p className="text-xs text-ink-3">No payment address</p>
        )}
        {canWrite && <EditAddress orgSlug={orgSlug} counterparty={counterparty} />}
      </div>
      {unconfirmedSince && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge size="sm" dot tone="held">
            Changed {unconfirmedSince.slice(0, 10)} · not yet confirmed
          </Badge>
          {canConfirm && <ConfirmAddress orgSlug={orgSlug} counterparty={counterparty} />}
        </div>
      )}
    </div>
  );
}

function EditAddress({ orgSlug, counterparty }: { orgSlug: string; counterparty: CounterpartyAddressProps["counterparty"] }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { state, formProps } = useActionForm(update, INITIAL, { onSuccess: close });
  const fieldId = `address-${counterparty.id}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" icon={<PencilLine />} className="shrink-0">
          Edit address
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`${counterparty.name}'s payment address`}
        description="After a change, the next payment to this counterparty waits for a person to approve it, whatever the amount."
      >
        <form {...formProps} className="grid gap-5">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="counterpartyId" value={counterparty.id} />
          <Field id={fieldId} label="Arc address" description="0x followed by 40 hex characters. Leave it empty to clear the address.">
            <Input name="address" defaultValue={counterparty.address ?? ""} maxLength={200} autoComplete="off" spellCheck={false} className="font-mono" />
          </Field>
          <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <SubmitButton pendingLabel="Saving…">Save address</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmAddress({ orgSlug, counterparty }: { orgSlug: string; counterparty: CounterpartyAddressProps["counterparty"] }) {
  const { state, formProps, pending } = useActionForm(confirm, INITIAL);
  const formId = `confirm-address-${counterparty.id}`;

  return (
    <div className="flex flex-col items-end gap-1">
      <form id={formId} className="contents" {...formProps}>
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="counterpartyId" value={counterparty.id} />
        <input type="hidden" name="address" value={counterparty.address ?? ""} />
      </form>
      <ConfirmDialog
        formId={formId}
        tone="primary"
        trigger={
          <Button size="sm" variant="secondary" icon={<BadgeCheck />} loading={pending}>
            Confirm address
          </Button>
        }
        title={`Confirm ${counterparty.name}'s new address?`}
        description={
          counterparty.address
            ? `Payments go to ${counterparty.address} without waiting for a person. Check it with ${counterparty.name} first.`
            : "The counterparty has no address, so the agent cannot pay it until one is set."
        }
        confirmLabel="Confirm address"
      />
      {state.message && !state.ok && <FormMessage tone="error">{state.message}</FormMessage>}
    </div>
  );
}
