"use client";

import { Plus } from "lucide-react";
import { createInvoiceAction, type IntakeActionResult } from "@/app/actions/intake";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: IntakeActionResult = { ok: false, message: "" };

export interface IntakeCounterparty {
  id: string;
  name: string;
  role: string;
}

/** One invoice, typed in. The agent evaluates it on its next cycle. */
export default function InvoiceIntake({ counterparties, orgSlug }: { counterparties: IntakeCounterparty[]; orgSlug: string }) {
  const { state, formProps } = useActionForm(createInvoiceAction, INITIAL, { resetOnSuccess: true, toastOnSuccess: true });
  const none = counterparties.length === 0;

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="invoice-direction" label="Direction">
          <Select name="direction" defaultValue="payable">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="payable">Payable</SelectItem>
              <SelectItem value="receivable">Receivable</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="invoice-counterparty" label="Counterparty" description={none ? "Add a counterparty first — every invoice is against one." : undefined}>
          <Select name="counterpartyId" required disabled={none}>
            <SelectTrigger>
              <SelectValue placeholder="Select a counterparty" />
            </SelectTrigger>
            <SelectContent>
              {counterparties.map((counterparty) => (
                <SelectItem key={counterparty.id} value={counterparty.id}>
                  {counterparty.name} · {counterparty.role}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="invoice-amount" label="Amount (USDC)">
          <Input name="amount" required inputMode="decimal" placeholder="1250.00" />
        </Field>
        <Field id="invoice-due" label="Due date">
          <Input name="dueDate" required type="date" />
        </Field>
        <Field id="invoice-memo" label="Memo" optional>
          <Input name="memo" maxLength={280} />
        </Field>
        <Field id="invoice-po" label="PO reference" optional>
          <Input name="poReference" maxLength={100} placeholder="PO-100" />
        </Field>
      </div>
      <Checkbox name="goodsReceived" label="Goods or services received" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
        <SubmitButton icon={<Plus />} disabled={none} pendingLabel="Adding…" className="shrink-0">
          Add invoice
        </SubmitButton>
      </div>
      <p className="text-xs text-ink-3">The agent will evaluate this invoice on the next cycle.</p>
    </form>
  );
}
