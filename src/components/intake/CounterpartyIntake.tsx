"use client";

import { ShieldCheck } from "lucide-react";
import { createCounterpartyAction, type IntakeActionResult } from "@/app/actions/intake";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { PAYEE_CHAINS } from "@/lib/payee-chains";

const INITIAL: IntakeActionResult = { ok: false, message: "" };

/** A new counterparty is screened the moment it is saved; the toast carries the verdict. */
export default function CounterpartyIntake({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(createCounterpartyAction, INITIAL, { resetOnSuccess: true, toastOnSuccess: true });

  return (
    <Card asChild className="p-4 sm:p-6">
      <form {...formProps}>
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field id="cp-name" label="Legal or trading name">
            <Input name="name" required maxLength={160} autoComplete="organization" />
          </Field>
          <Field id="cp-role" label="Role">
            <Select name="role" defaultValue="vendor">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vendor">Vendor</SelectItem>
                <SelectItem value="contractor">Contractor</SelectItem>
                <SelectItem value="client">Client</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="cp-limit" label="Payment limit (USDC)" description="May be blank for clients">
            <Input name="paymentLimit" inputMode="decimal" placeholder="5000.00" />
          </Field>
          <Field id="cp-chain" label="Chain" description="Another chain is paid from Arc through CCTP, for a fee">
            <Select name="chain" defaultValue="ARC-TESTNET">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYEE_CHAINS.map((chain) => (
                  <SelectItem key={chain.id} value={chain.id}>
                    {chain.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="cp-address" label="Payment address" description="Optional until payment setup">
            <Input name="address" maxLength={200} autoComplete="off" className="font-mono" />
          </Field>
          <Field id="cp-jurisdiction" label="Jurisdiction" description="ISO code or country name">
            <Input name="jurisdiction" maxLength={80} placeholder="US" />
          </Field>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-ink-3">The configured limit is preserved as the baseline; screening derives current payment authority.</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
          <SubmitButton icon={<ShieldCheck />} pendingLabel="Adding and screening…" className="shrink-0">
            Add and screen
          </SubmitButton>
        </div>
      </form>
    </Card>
  );
}
