"use client";

import { useCallback, useState } from "react";
import { updateCounterpartyLimitAction, type IntakeActionResult } from "@/app/actions/intake";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { RULE_TRIAL_COPY, RuleTrial, useRuleTrial } from "@/components/RuleTrial";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";

const INITIAL: IntakeActionResult = { ok: false, message: "" };
const update = withSuccessToast(updateCounterpartyLimitAction);

/**
 * "Edit limit" beside a counterparty's configured limit, for owners and
 * admins. The action writes the configured limit and the current one
 * screening derives from it together (src/lib/counterparty-limit.ts). The figure
 * typed in can be tried on past decisions first, and applied from the result
 * (docs/superpowers/specs/2026-10-10-policy-replay-design.md).
 */
export default function CounterpartyLimitEdit({
  orgSlug,
  counterparty,
}: {
  orgSlug: string;
  counterparty: { id: string; name: string; role: string; baselineLimit: number | null };
}) {
  const [open, setOpen] = useState(false);
  const trial = useRuleTrial("counterparty_limit");
  const { clear } = trial;
  const close = useCallback(() => {
    setOpen(false);
    clear();
  }, [clear]);
  const { state, formProps } = useActionForm(update, INITIAL, { onSuccess: close });
  const fieldId = `limit-${counterparty.id}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) clear();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="link" className="text-xs" aria-label={`Edit ${counterparty.name}'s payment limit`}>
          Edit limit
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`${counterparty.name}'s payment limit`}
        description="The most the agent pays this counterparty in one payment on its own. Anything above it waits for a person to approve. Screening can lower it for risk."
      >
        <form {...formProps} onChange={clear} className="grid gap-5">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="counterpartyId" value={counterparty.id} />
          <Field
            id={fieldId}
            label="Payment limit (USDC)"
            description={counterparty.role === "client" ? "Leave it empty for no limit." : "A vendor or contractor always has a limit."}
          >
            <Input name="paymentLimit" inputMode="decimal" defaultValue={counterparty.baselineLimit ?? ""} autoComplete="off" />
          </Field>
          <RuleTrial orgSlug={orgSlug} trial={trial} />
          <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <SubmitButton pendingLabel="Saving…">{trial.view ? RULE_TRIAL_COPY.apply : "Save limit"}</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
