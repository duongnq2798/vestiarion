"use client";

import { PenLine } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { recordActualPaymentAction } from "@/app/actions/actual-payments";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { ACTUAL_METHODS, METHOD_WORDS, NOTE_MAX, REASON_MAX, REFERENCE_MAX, type ActualMethod } from "@/lib/actual-payment-fields";
import { billDigits } from "@/lib/bill-amount";

/**
 * Records how the business paid one bill outside Vestiarion, or that it did not (docs/superpowers/specs/2026-10-10-
 * actual-payments-design.md A1, A5): the day, the amount and currency as paid (the bill's own by default), the method, a
 * reference and a note; or Not paid, with a reason. On a bill recorded already it corrects the newest record, which
 * stays in the history. The server checks every field again.
 */

export interface CurrentRecord {
  id: string;
  outcome: "paid" | "not_paid";
  paidOn: string | null;
  amount: number | null;
  currency: string | null;
  method: ActualMethod | null;
  reference: string | null;
  note: string | null;
  reason: string | null;
}

const OUTCOMES = [
  { value: "paid", label: "Paid", description: "Your business paid it outside Vestiarion." },
  { value: "not_paid", label: "Not paid", description: "Your business did not pay it, or will not." },
] as const;

type Note = { tone: "neutral" | "error"; text: string } | null;

export default function ActualPaymentControl({
  orgSlug,
  invoiceId,
  payee,
  bill,
  current,
}: {
  orgSlug: string;
  invoiceId: string;
  payee: string;
  /** The bill in its own currency: the amount and currency the form starts at. */
  bill: { amount: number; currency: string };
  current: CurrentRecord | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<Note>(null);
  const [outcome, setOutcome] = useState<"paid" | "not_paid">(current?.outcome ?? "paid");
  const [method, setMethod] = useState<ActualMethod>(current?.method ?? "bank_transfer");
  const today = new Date().toISOString().slice(0, 10);
  const id = (field: string) => `actual-${invoiceId}-${field}`;
  const startAmount = current?.amount ?? bill.amount;
  const startCurrency = current?.currency ?? bill.currency;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const read = (name: string) => String(form.get(name) ?? "");
    const replaces = current?.id ?? null;
    const input =
      outcome === "paid"
        ? { invoiceId, outcome, paidOn: read("paidOn"), amount: read("amount"), currency: read("currency"), method, reference: read("reference"), note: read("note"), replaces }
        : { invoiceId, outcome, reason: read("reason"), note: read("note"), replaces };
    startTransition(async () => {
      setNote(null);
      const result = await recordActualPaymentAction(orgSlug, input);
      setNote({ tone: result.ok ? "neutral" : "error", text: result.message });
      if (result.ok) {
        setOpen(false);
        router.refresh();
      }
    });
  };

  return (
    <div className="space-y-1">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant={current ? "ghost" : "secondary"} icon={<PenLine />}>
            {current ? "Correct" : "Record what you paid"}
          </Button>
        </DialogTrigger>
        <DialogContent
          title={current ? `Correct what you recorded for ${payee}` : `What did your business do about ${payee}?`}
          description={current ? "The record you correct stays in the history, and the audit log keeps both." : "Recorded in this workspace's signed ledger, beside the agent's decision."}
        >
          <form onSubmit={submit} className="grid gap-5">
            <RadioGroup legend="Outcome" options={OUTCOMES} value={outcome} onValueChange={(value) => setOutcome(value === "not_paid" ? "not_paid" : "paid")} />
            {outcome === "paid" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id={id("day")} label="Day paid">
                  <Input name="paidOn" type="date" required max={today} defaultValue={current?.paidOn ?? today} />
                </Field>
                <Field id={id("method")} label="How it was paid">
                  <Select value={method} onValueChange={(value) => setMethod(ACTUAL_METHODS.find((item) => item === value) ?? "other")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ACTUAL_METHODS.map((item) => (
                        <SelectItem key={item} value={item}>
                          {METHOD_WORDS[item]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field id={id("amount")} label="Amount paid" description="As it left your account.">
                  <Input name="amount" required inputMode="decimal" defaultValue={startAmount.toFixed(billDigits(startCurrency))} />
                </Field>
                <Field id={id("currency")} label="Currency" description="The bill's own, unless you paid in another.">
                  <Input name="currency" required maxLength={4} defaultValue={startCurrency} className="uppercase" />
                </Field>
                <Field id={id("reference")} label="Reference" optional className="sm:col-span-2">
                  <Input name="reference" maxLength={REFERENCE_MAX} defaultValue={current?.reference ?? ""} placeholder="The bank's or the card's reference" />
                </Field>
              </div>
            ) : (
              <Field id={id("reason")} label="Why was it not paid?" description={`At most ${REASON_MAX} characters.`}>
                <Textarea name="reason" required maxLength={REASON_MAX} rows={3} defaultValue={current?.reason ?? ""} />
              </Field>
            )}
            <Field id={id("note")} label="Note" optional>
              <Textarea name="note" maxLength={NOTE_MAX} rows={2} defaultValue={current?.note ?? ""} />
            </Field>
            <FormMessage tone={note?.tone ?? "neutral"}>{open ? note?.text : null}</FormMessage>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <Button type="submit" loading={pending}>
                {current ? "Save the correction" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {!open && note && <FormMessage tone={note.tone}>{note.text}</FormMessage>}
    </div>
  );
}
