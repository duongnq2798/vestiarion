"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { createInvoiceAction, type IntakeActionResult } from "@/app/actions/intake";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: IntakeActionResult = { ok: false, message: "" };

type Direction = "payable" | "receivable";

/** What the direction means for the counterparty chosen, and a warning for a payable to a client (client payables R2). */
export function directionNote(direction: Direction, counterparty: { name: string; role: string } | undefined): string | undefined {
  if (!counterparty) return undefined;
  if (direction === "receivable") return `Money ${counterparty.name} owes you.`;
  return counterparty.role === "client"
    ? `${counterparty.name} is a client: it pays you. The agent never pays a client on its own; a payable to one waits for a person.`
    : `Money you owe ${counterparty.name}.`;
}

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
  kind: "pdf" | "email" | "text";
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
  idPrefix = "invoice",
}: {
  counterparties: IntakeCounterparty[];
  orgSlug: string;
  initial?: InvoiceFormInitial;
  document?: InvoiceFormDocument;
  onAdded?: () => void;
  /** Distinct per form on a page, so each label names its own field (review I5). */
  idPrefix?: string;
}) {
  const { state, formProps } = useActionForm(createInvoiceAction, INITIAL, { resetOnSuccess: true, toastOnSuccess: true, onSuccess: onAdded });
  const none = counterparties.length === 0;
  const start = (value: string | null | undefined) => value ?? undefined;
  // Typed in, an invoice is in USDC unless changed. Read from a document that names no currency, the member chooses.
  const currency = initial ? (initial.currency === "USDC" || initial.currency === "EURC" ? initial.currency : undefined) : "USDC";
  const id = (field: string) => `${idPrefix}-${field}`;
  const fieldError = (field: keyof NonNullable<IntakeActionResult["fieldErrors"]>) => (state.ok ? undefined : state.fieldErrors?.[field]);

  // A discount comes with its deadline: once either half is filled in, the other is required, and the
  // deadline can be no later than the due date. Tracked as typed; the fields themselves stay uncontrolled,
  // so a reset after an invoice is added clears them, and these go back with them.
  const [discountPct, setDiscountPct] = useState(initial?.earlyPayDiscountPct ?? "");
  const [discountDeadline, setDiscountDeadline] = useState(initial?.discountDeadline ?? "");
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? "");
  const pctEntered = discountPct.trim() !== "";
  const deadlineEntered = discountDeadline !== "";

  // The direction follows the counterparty chosen: a client pays you, so its invoice is a receivable; anyone else is
  // paid (client payables R2). A person can still choose otherwise, and the form says what that means.
  const roleOf = (counterpartyId: string | null | undefined) => counterparties.find((counterparty) => counterparty.id === counterpartyId);
  const directionFor = (counterpartyId: string | null | undefined): Direction => (roleOf(counterpartyId)?.role === "client" ? "receivable" : "payable");
  const [chosen, setChosen] = useState<string | null>(initial?.counterpartyId ?? null);
  const [direction, setDirection] = useState<Direction>(directionFor(initial?.counterpartyId));
  const chosenParty = roleOf(chosen);

  function resetDiscount() {
    setDiscountPct(initial?.earlyPayDiscountPct ?? "");
    setDiscountDeadline(initial?.discountDeadline ?? "");
    setDueDate(initial?.dueDate ?? "");
    setChosen(initial?.counterpartyId ?? null);
    setDirection(directionFor(initial?.counterpartyId));
  }

  return (
    <form {...formProps} onReset={resetDiscount} className="space-y-4">
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
        <Field id={id("direction")} label="Direction" description={directionNote(direction, chosenParty)} error={fieldError("direction")}>
          <Select name="direction" value={direction} onValueChange={(value) => setDirection(value === "receivable" ? "receivable" : "payable")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="payable">Payable</SelectItem>
              <SelectItem value="receivable">Receivable</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          id={id("counterparty")}
          label="Counterparty"
          description={none ? "Add a counterparty first — every invoice is against one." : undefined}
          error={fieldError("counterpartyId")}
        >
          <Select
            name="counterpartyId"
            required
            disabled={none}
            defaultValue={start(initial?.counterpartyId)}
            onValueChange={(value) => {
              setChosen(value);
              setDirection(directionFor(value));
            }}
          >
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
        <Field id={id("amount")} label="Amount" error={fieldError("amount")}>
          <Input name="amount" required inputMode="decimal" placeholder="1250.00" defaultValue={start(initial?.amount)} />
        </Field>
        <Field
          id={id("currency")}
          label="Currency"
          description="A EURC payable is paid in EURC, and checked against the payment limit at its USDC value."
          error={fieldError("currency")}
        >
          <Select name="currency" defaultValue={currency} required={currency === undefined}>
            <SelectTrigger>
              <SelectValue placeholder="Choose USDC or EURC" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="USDC">USDC</SelectItem>
              <SelectItem value="EURC">EURC</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id={id("due")} label="Due date" error={fieldError("dueDate")}>
          <Input name="dueDate" required type="date" defaultValue={start(initial?.dueDate)} onChange={(event) => setDueDate(event.target.value)} />
        </Field>
        <Field id={id("discount-pct")} label="Early-payment discount (%)" optional={!deadlineEntered} error={fieldError("earlyPayDiscountPct")}>
          {/* No placeholder: an example percent in an empty field reads as one already entered. */}
          <Input
            name="earlyPayDiscountPct"
            inputMode="decimal"
            required={deadlineEntered}
            defaultValue={start(initial?.earlyPayDiscountPct)}
            onChange={(event) => setDiscountPct(event.target.value)}
          />
        </Field>
        <Field
          id={id("discount-deadline")}
          label="Discount deadline"
          optional={!pctEntered}
          description="Needed with a discount: the last day it applies, on or before the due date."
          error={fieldError("discountDeadline")}
        >
          <Input
            name="discountDeadline"
            type="date"
            required={pctEntered}
            max={dueDate || undefined}
            defaultValue={start(initial?.discountDeadline)}
            onChange={(event) => setDiscountDeadline(event.target.value)}
          />
        </Field>
        <Field id={id("memo")} label="Memo" optional error={fieldError("memo")}>
          <Input name="memo" maxLength={280} defaultValue={start(initial?.memo)} />
        </Field>
        <Field id={id("po")} label="PO reference" optional error={fieldError("poReference")}>
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
