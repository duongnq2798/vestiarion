"use client";

import { useCallback, useState } from "react";
import { setBankAccountAction, stopBankAccountAction, type BankPayoutsActionResult } from "@/app/actions/bank-payouts";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";
import { clabeBank } from "@/lib/blindpay/clabe";

const INITIAL: BankPayoutsActionResult = { ok: false, message: "" };
const set = withSuccessToast(setBankAccountAction);
const stop = withSuccessToast(stopBankAccountAction);

export interface BankAccountShown {
  bankCode: string;
  last4: string;
  beneficiaryName: string;
  status: string;
}

/** "BBVA ····9716, Ana López": a vendor's bank account as the card says it (bank payouts B12). */
export function bankAccountWords(account: BankAccountShown): string {
  return `${clabeBank(account.bankCode)} ····${account.last4}, ${account.beneficiaryName}`;
}

function Remove({ orgSlug, counterparty }: { orgSlug: string; counterparty: { id: string; name: string } }) {
  const { state, formProps } = useActionForm(stop, INITIAL);
  return (
    <form {...formProps} className="inline-flex items-baseline gap-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="counterpartyId" value={counterparty.id} />
      <input type="hidden" name="counterpartyName" value={counterparty.name} />
      <SubmitButton size="sm" variant="link" className="text-xs" pendingLabel="Removing…" aria-label={`Stop paying ${counterparty.name} to its bank account`}>
        Remove
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

/**
 * A vendor's bank account in Mexico (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B4): where its bills are
 * paid, in pesos over SPEI, through BlindPay. An owner or admin adds or replaces it; the CLABE goes to BlindPay and only
 * the bank and its last four digits are kept. Once added, the vendor's address is not used.
 */
export default function CounterpartyBankAccount({
  orgSlug,
  counterparty,
  account,
  canManage,
  setUp,
}: {
  orgSlug: string;
  counterparty: { id: string; name: string };
  account: BankAccountShown | null;
  canManage: boolean;
  /** Whether the workspace is set up with BlindPay (Settings, Bank payouts). */
  setUp: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { state, formProps } = useActionForm(set, INITIAL, { onSuccess: close });
  const id = `bank-${counterparty.id}`;

  return (
    <div className="mt-3 text-xs">
      <p className="text-ink-3">Bank account in Mexico (SPEI)</p>
      <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-ink">
        {account ? (
          <>
            <span>Paid to {bankAccountWords(account)}, through BlindPay.</span>
            {account.status !== "approved" && <span className="text-held">BlindPay is checking it.</span>}
          </>
        ) : (
          <span className="text-ink-2">None: paid to its address.</span>
        )}
        {canManage && setUp && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="link" className="text-xs" aria-label={`${account ? "Replace" : "Add"} ${counterparty.name}'s bank account`}>
                {account ? "Replace" : "Add"}
              </Button>
            </DialogTrigger>
            <DialogContent
              title={`${counterparty.name}'s bank account in Mexico`}
              description="Its bills are paid here in pesos over SPEI, through BlindPay, instead of to its address. Vestiarion keeps only the bank and the last four digits; the CLABE goes to BlindPay."
            >
              <form {...formProps} className="grid gap-5">
                <input type="hidden" name="orgSlug" value={orgSlug} />
                <input type="hidden" name="counterpartyId" value={counterparty.id} />
                <Field id={`${id}-name`} label="Name the account is held in">
                  <Input name="beneficiaryName" maxLength={128} autoComplete="off" required placeholder="Ana López" />
                </Field>
                <Field id={`${id}-clabe`} label="CLABE" description="18 digits, from the vendor's bank statement or app.">
                  <Input name="clabe" inputMode="numeric" maxLength={24} autoComplete="off" required placeholder="012 180 00011835971 6" />
                </Field>
                <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="secondary">Cancel</Button>
                  </DialogClose>
                  <SubmitButton pendingLabel="Sending to BlindPay…">Save</SubmitButton>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
        {canManage && account && <Remove orgSlug={orgSlug} counterparty={counterparty} />}
      </p>
      {canManage && !setUp && !account && <p className="mt-0.5 text-ink-3">Set up bank payouts under Settings to pay it in pesos.</p>}
    </div>
  );
}
