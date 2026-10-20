"use client";

import { BadgeCheck, PencilLine, TriangleAlert } from "lucide-react";
import { useCallback, useState } from "react";
import {
  confirmCounterpartyAddressAction,
  updateCounterpartyAddressAction,
  type IntakeActionResult,
} from "@/app/actions/intake";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";
import { chainById } from "@/lib/payee-chains";
import {
  EARLIER_LOOKALIKE,
  lookalikeWords,
  VERIFICATION_CONTACT_MAX,
  VERIFICATION_LABELS,
  VERIFICATION_METHODS,
  VERIFICATION_NOTE_MAX,
  type Lookalike,
} from "@/lib/payee-lock-rules";

const INITIAL: IntakeActionResult = { ok: false, message: "" };
const update = withSuccessToast(updateCounterpartyAddressAction);
const confirm = withSuccessToast(confirmCounterpartyAddressAction);

export interface CounterpartyAddressProps {
  orgSlug: string;
  /** `chain`, the chain it is paid on (its own, or the workspace's when it has none), is shown beside the address. */
  counterparty: { id: string; name: string; address: string | null; chain?: string };
  /** When the address was changed, while no one has confirmed it; null otherwise. */
  unconfirmedSince: string | null;
  canWrite: boolean;
  canConfirm: boolean;
  /** Whether the workspace's payee lock is on (payee lock PL2): the confirm form's record is then required. */
  payeeLockOn?: boolean;
  /** Other counterparties whose address is this one, or made to look like it (PL6). */
  lookalikes?: readonly Lookalike[];
  /** An address this payee had or was paid at before that its changed one is made to look like (PL6); null when none. */
  earlierLookalike?: string | null;
}

/**
 * A counterparty's payment address on its card: shown, edited by owners and
 * admins, and, after a change, confirmed by anyone who may approve payments
 * (spec 2026-09-30-counterparty-address-edit). Until then the agent holds
 * every payment to it for a person. The chain is part of what a person
 * confirms (payee invoice link P3): it is named beside the address, in the
 * confirmation, and sent with it.
 */
export default function CounterpartyAddress({
  orgSlug,
  counterparty,
  unconfirmedSince,
  canWrite,
  canConfirm,
  payeeLockOn = false,
  lookalikes = [],
  earlierLookalike = null,
}: CounterpartyAddressProps) {
  const chainLabel = counterparty.chain ? chainById(counterparty.chain).label : null;
  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        {counterparty.address ? (
          <p className="flex min-w-0 items-baseline gap-1.5 text-ink-3">
            <span className="min-w-0 truncate font-mono text-[0.7rem]" title={counterparty.address}>
              {counterparty.address}
            </span>
            {chainLabel && <span className="shrink-0 text-xs">on {chainLabel}</span>}
          </p>
        ) : (
          <p className="text-xs text-ink-3">No payment address</p>
        )}
        {canWrite && <EditAddress orgSlug={orgSlug} counterparty={counterparty} />}
      </div>
      {(lookalikes.length > 0 || earlierLookalike) && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Lookalike addresses">
          {earlierLookalike && (
            <li>
              <Badge size="sm" tone="refused" icon={<TriangleAlert aria-hidden />} title={earlierLookalike}>
                {EARLIER_LOOKALIKE}
              </Badge>
            </li>
          )}
          {lookalikes.map((match) => (
            <li key={match.id}>
              <Badge size="sm" tone="refused" icon={<TriangleAlert aria-hidden />}>
                {lookalikeWords(match)}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {unconfirmedSince && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge size="sm" dot tone="held">
            Changed {unconfirmedSince.slice(0, 10)} · not yet confirmed
          </Badge>
          {canConfirm && (
            <ConfirmAddress orgSlug={orgSlug} counterparty={counterparty} payeeLockOn={payeeLockOn} lookalikes={lookalikes} earlierLookalike={earlierLookalike} />
          )}
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

/**
 * Confirm address, with the record of how the address was checked (payee lock PL2): the method, the contact used and
 * whether it was on file before the new address arrived, and a note. Optional with the payee lock off; required with it
 * on, as the action checks again. Lookalike addresses are named here before anyone confirms (PL6).
 */
function ConfirmAddress({
  orgSlug,
  counterparty,
  payeeLockOn,
  lookalikes,
  earlierLookalike,
}: {
  orgSlug: string;
  counterparty: CounterpartyAddressProps["counterparty"];
  payeeLockOn: boolean;
  lookalikes: readonly Lookalike[];
  earlierLookalike: string | null;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { state, formProps } = useActionForm(confirm, INITIAL, { onSuccess: close });
  const formId = `confirm-address-${counterparty.id}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" icon={<BadgeCheck />}>
          Confirm address
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Confirm ${counterparty.name}'s new address?`}
        description={
          counterparty.address
            ? `Payments go to ${counterparty.address}${counterparty.chain ? ` on ${chainById(counterparty.chain).label}` : ""} without waiting for a person. Check it with ${counterparty.name} first.`
            : "The counterparty has no address, so the agent cannot pay it until one is set."
        }
      >
        <form id={formId} className="grid gap-4" {...formProps}>
          <ConfirmAddressFields
            orgSlug={orgSlug}
            counterparty={counterparty}
            payeeLockOn={payeeLockOn}
            lookalikes={lookalikes}
            earlierLookalike={earlierLookalike}
            idPrefix={formId}
          />
          <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <SubmitButton pendingLabel="Confirming…" icon={<BadgeCheck />}>
              Confirm address
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What Confirm address posts (payee lock PL2): the address and chain the page showed, and the record of how the address
 * was checked, with any lookalike named above it (PL6). Exported for its tests: the dialog renders it only when open.
 */
export function ConfirmAddressFields({
  orgSlug,
  counterparty,
  payeeLockOn,
  lookalikes,
  earlierLookalike = null,
  idPrefix,
}: {
  orgSlug: string;
  counterparty: CounterpartyAddressProps["counterparty"];
  payeeLockOn: boolean;
  lookalikes: readonly Lookalike[];
  earlierLookalike?: string | null;
  idPrefix: string;
}) {
  // With the lock off every field is optional; with it on, a call or a message names its contact (the action checks).
  const contactOptional = !payeeLockOn;
  const formId = idPrefix;
  return (
    <>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="counterpartyId" value={counterparty.id} />
      <input type="hidden" name="address" value={counterparty.address ?? ""} />
      {counterparty.chain && <input type="hidden" name="chain" value={counterparty.chain} />}
      {earlierLookalike && (
        <Callout tone="refused" title="Check every character">
          {EARLIER_LOOKALIKE}: it starts and ends like <span className="break-all font-mono text-xs">{earlierLookalike}</span>, but it is a
          different address. That is how address poisoning works. Read the whole address back to {counterparty.name}.
        </Callout>
      )}
      {lookalikes.length > 0 && (
        <Callout tone="refused" title="Check this address twice">
          {lookalikes.map(lookalikeWords).join(". ")}. A fraudster may have made it look like an address you know.
        </Callout>
      )}
      <p className="text-sm text-ink-2">
        {payeeLockOn
          ? "The payee lock needs a record of how you checked it. Use a contact you had before the new address arrived, never one that came with it."
          : "Record how you checked it, so the ledger shows it later. Use a contact you had before the new address arrived, never one that came with it."}
      </p>
      <RadioGroup
        name="method"
        legend={payeeLockOn ? "How did you check it?" : "How did you check it? (optional)"}
        options={VERIFICATION_METHODS.map((method) => ({ value: method, label: VERIFICATION_LABELS[method] }))}
        required={payeeLockOn}
      />
      <Field id={`${formId}-contact`} label="Contact used" description="The number or channel, and where you had it from." optional={contactOptional}>
        <Input name="contact" maxLength={VERIFICATION_CONTACT_MAX} placeholder="+44 20 7946 0000, from our contract" />
      </Field>
      <Checkbox name="contactOnFileBefore" label="This contact was on file before the new address arrived" />
      <Field id={`${formId}-note`} label="Note" description="Plain text, no links." optional>
        <Textarea name="note" rows={2} maxLength={VERIFICATION_NOTE_MAX} />
      </Field>
    </>
  );
}
