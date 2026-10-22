"use client";

import { LockOpen } from "lucide-react";
import { unfreezeCounterpartyAction } from "@/app/actions/intake";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Textarea } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { aboutAddress, checkLine, type AddressCheckStatus } from "@/lib/address-change-check-words";

const INITIAL = { ok: false, message: "" };

export interface AddressCheckShown {
  frozen: boolean;
  check: { status: AddressCheckStatus; sentAt: string | null; expired: boolean; to: string } | null;
}

/**
 * What a payee's row says of "Was this you?" (docs/superpowers/specs/2026-10-22-address-change-check-design.md AC5): the
 * contact's answer, or that it has not answered; and for a frozen payee, a notice with Unfreeze for an owner or admin,
 * who says how they checked (AC4). Rendered for every row, so the answer to an unfreeze outlives the notice it removes.
 */
export function AddressCheckNote({
  orgSlug,
  counterparty,
  view,
  canUnfreeze,
}: {
  orgSlug: string;
  counterparty: { id: string; name: string; address: string | null };
  view: AddressCheckShown | null;
  canUnfreeze: boolean;
}) {
  const { state, pending, formProps } = useActionForm(unfreezeCounterpartyAction, INITIAL, { toastOnSuccess: true });
  if (!view) return null;
  // A check about an address no longer on file says nothing of the one that is.
  const check = view.check && aboutAddress(view.check.to, counterparty.address) ? view.check : null;
  const line = view.frozen
    ? checkLine({ status: "disputed", sentAt: null, frozen: true })
    : check
      ? checkLine({ status: check.status, sentAt: check.sentAt, frozen: false, expired: check.expired })
      : null;
  if (!line) return null;
  if (!view.frozen) return <p className="mt-1 text-xs text-ink-3">{line}</p>;
  return (
    <Callout tone="refused" title={`${counterparty.name} is frozen`} className="mt-2">
      <p>
        Their billing email said they did not make the change to this address. No one can confirm it, and no approval pays them, until an owner or admin
        checks with them by a contact you had before and unfreezes them.
      </p>
      {canUnfreeze && (
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="secondary" size="sm" icon={<LockOpen />} className="mt-2">
              Unfreeze
            </Button>
          </DialogTrigger>
          <DialogContent title={`Unfreeze ${counterparty.name}?`} description="The address still needs confirming afterwards, before anything is paid to it.">
            <form {...formProps} className="grid gap-4">
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="counterpartyId" value={counterparty.id} />
              <Field id={`unfreeze-${counterparty.id}`} label={`How did you check with ${counterparty.name}?`}>
                <Textarea name="note" required minLength={3} maxLength={500} rows={3} />
              </Field>
              <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="secondary" disabled={pending}>
                    Cancel
                  </Button>
                </DialogClose>
                <SubmitButton pendingLabel="Unfreezing…" icon={<LockOpen aria-hidden />}>
                  Unfreeze
                </SubmitButton>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </Callout>
  );
}
