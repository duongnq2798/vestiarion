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

/** Values to start the form with: an invoice read from a document (invoice from a document D7). */
export interface InvoiceFormInitial {
  counterpartyId?: string | null;
  amount?: string | null;
  currency?: string | null;
  dueDate?: string | null;
  earlyPayDiscountPct?: string | null;
  discountDeadline?: string | null;
  memo?: string | null;
  poReference?: string | null;
}

/** The document an invoice was read from, recorded on its ledger entry (D8). `read` is the JSON of the values read. */
export interface InvoiceFormDocument {
  kind: "pdf" | "text";
  sha256: string;
  reader: string;
  read: string;
}

/** One invoice, typed in or read from a document, in USDC or EURC. The agent evaluates it on its next cycle. */
export default function InvoiceIntake({
  counterparties,
  orgSlug,
  initial,
  document,
  onAdded,
}: {
  counterparties: IntakeCounterparty[];
  orgSlug: string;
  initial?: InvoiceFormInitial;
  document?: InvoiceFormDocument;
  onAdded?: () => void;
}) {
  const { state, formProps } = useActionForm(createInvoiceAction, INITIAL, { resetOnSuccess: true, toastOnSuccess: true, onSuccess: onAdded });
  const none = counterparties.length === 0;
  const start = (value: string | null | undefined) => value ?? undefined;

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      {document && (
        <>
          <input type="hidden" name="documentSha256" value={document.sha256} />
          <input type="hidden" name="documentKind" value={document.kind} />
          <input type="hidden" name="documentReader" value={document.reader} />
          <input type="hidden" name="documentRead" value={document.read} />
        </>
      )}
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
          <Select name="counterpartyId" required disabled={none} defaultValue={start(initial?.counterpartyId)}>
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
        <Field id="invoice-amount" label="Amount">
          <Input name="amount" required inputMode="decimal" placeholder="1250.00" defaultValue={start(initial?.amount)} />
        </Field>
        <Field id="invoice-currency" label="Currency" description="A EURC payable is paid in EURC, and checked against the payment limit at its USDC value.">
          <Select name="currency" defaultValue={initial?.currency === "EURC" ? "EURC" : "USDC"}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="USDC">USDC</SelectItem>
              <SelectItem value="EURC">EURC</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="invoice-due" label="Due date">
          <Input name="dueDate" required type="date" defaultValue={start(initial?.dueDate)} />
        </Field>
        <Field id="invoice-discount-pct" label="Early-payment discount (%)" optional>
          <Input name="earlyPayDiscountPct" inputMode="decimal" placeholder="2" defaultValue={start(initial?.earlyPayDiscountPct)} />
        </Field>
        <Field id="invoice-discount-deadline" label="Discount deadline" optional>
          <Input name="discountDeadline" type="date" defaultValue={start(initial?.discountDeadline)} />
        </Field>
        <Field id="invoice-memo" label="Memo" optional>
          <Input name="memo" maxLength={280} defaultValue={start(initial?.memo)} />
        </Field>
        <Field id="invoice-po" label="PO reference" optional>
          <Input name="poReference" maxLength={100} placeholder="PO-100" defaultValue={start(initial?.poReference)} />
        </Field>
      </div>
      <Checkbox
        name="goodsReceived"
        label="Goods or services received"
        description={document ? "A document cannot say this; tick it only if you received them." : undefined}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
        <SubmitButton icon={<Plus />} disabled={none} pendingLabel="Adding…" className="shrink-0">
          Add invoice
        </SubmitButton>
      </div>
      <p className="text-xs text-ink-3">The agent usually decides on a payable within a minute of adding it.</p>
    </form>
  );
}
