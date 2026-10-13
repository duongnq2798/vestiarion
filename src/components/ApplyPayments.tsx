"use client";

import { HandCoins, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { applyPaymentAction } from "@/app/actions/allocations";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { Hash, Money } from "@/components/vx/Primitives";
import { REASON_MAX } from "@/lib/allocations/model";
import type { PaymentView, SuggestionView } from "@/lib/allocations/view";
import { utcDay } from "@/lib/copy";
import type { Network } from "@/lib/network";
import { homeChain } from "@/lib/payee-chains";

/**
 * Money received on Arc not applied in full yet, with how to apply it (docs/superpowers/specs/2026-10-12-allocations-
 * design.md L9, L11): each payment, what is left of it and whose credit that is, the agent's suggestions with why, and
 * Apply by hand. A person confirms; the server plans and checks every row again, and the database holds the line when
 * two people act at once. Money in with no suggestion is folded below.
 */

type Note = { tone: "neutral" | "error"; text: string } | null;

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6, useGrouping: false });
const typed = (amount: number) => AMOUNT.format(amount);
/** The fee's invoice when none is chosen: a select's item needs a value. */
const NO_FEE = "none";
const shortAddress = (address: string) => (address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);

export function ApplyPayments({ orgSlug, network, payments, canWrite }: { orgSlug: string; network: Network; payments: PaymentView[]; canWrite: boolean }) {
  const leading = payments.filter((payment) => payment.suggestions.length > 0 || payment.creditFor !== null);
  const rest = payments.filter((payment) => !leading.includes(payment));
  return (
    <section aria-labelledby="apply-payments-title" className="mb-6" data-apply-payments>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 id="apply-payments-title" className="text-sm font-semibold text-ink">
          Apply payments <span className="font-normal text-ink-3">{payments.length}</span>
        </h3>
        <p className="text-xs text-ink-3">Money received on {homeChain(network).label} not applied to invoices in full.</p>
      </div>
      {!canWrite && <p className="mb-2 text-xs text-ink-3">Only an owner, admin or accountant of this workspace can apply payments.</p>}
      <div className="grid gap-3">
        {leading.map((payment) => (
          <PaymentCard key={payment.id} orgSlug={orgSlug} network={network} payment={payment} canWrite={canWrite} />
        ))}
      </div>
      {rest.length > 0 && (
        <Disclosure className="mt-3" summary={`Other money in, with no suggestion (${rest.length})`} contentClassName="grid gap-3 px-3 pb-3">
          {rest.map((payment) => (
            <PaymentCard key={payment.id} orgSlug={orgSlug} network={network} payment={payment} canWrite={canWrite} />
          ))}
        </Disclosure>
      )}
    </section>
  );
}

function PaymentCard({ orgSlug, network, payment, canWrite }: { orgSlug: string; network: Network; payment: PaymentView; canWrite: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<Note>(null);
  const explorer = homeChain(network).explorerTx;

  const apply = (input: { lines: Array<{ invoiceId: string; amount: string }>; fees: Array<{ invoiceId: string; amount: string; reason: string }>; suggestion?: SuggestionView }) =>
    new Promise<boolean>((resolve) => {
      startTransition(async () => {
        setNote(null);
        const result = await applyPaymentAction(orgSlug, {
          paymentId: payment.id,
          version: payment.version,
          lines: input.lines,
          fees: input.fees,
          suggestion: input.suggestion ? { rule: input.suggestion.rule, why: input.suggestion.why } : null,
        });
        setNote({ tone: result.ok ? "neutral" : "error", text: result.message });
        // A payment someone changed meanwhile is shown again as it is now, as is one applied.
        router.refresh();
        resolve(result.ok);
      });
    });

  return (
    <Card className="p-4" data-payment={payment.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm text-ink">
          <Money value={payment.amount} token={payment.currency} className="font-semibold text-ink" /> received {utcDay(payment.receivedAt)}
          {payment.sender ? ` from ${payment.sender}` : payment.from ? ` from ${shortAddress(payment.from)}` : ""}
        </p>
        {payment.txHash && <Hash value={payment.txHash} href={`${explorer}${payment.txHash}`} />}
      </div>
      <p className="mt-1 text-xs text-ink-2">
        {payment.applied > 0 ? (
          <>
            <Money value={payment.applied} token={payment.currency} /> applied. <Money value={payment.unapplied} token={payment.currency} /> left
            {payment.creditFor ? ` as credit for ${payment.creditFor}` : ""}.
          </>
        ) : (
          "Not applied to an invoice yet."
        )}
      </p>

      {payment.suggestions.length > 0 && (
        <ul className="mt-3 grid gap-2" aria-label="Suggestions">
          {payment.suggestions.map((suggestion, index) => (
            <li key={`${suggestion.rule}-${index}`} className="rounded-lg border border-line bg-ground/40 p-3">
              <SuggestionRow suggestion={suggestion} currency={payment.currency} canWrite={canWrite} pending={pending} apply={apply} />
            </li>
          ))}
        </ul>
      )}

      {canWrite && payment.choices.length > 0 && (
        <div className="mt-3">
          <ApplyByHand payment={payment} pending={pending} apply={apply} />
        </div>
      )}
      {note && <FormMessage tone={note.tone} className="mt-2">{note.text}</FormMessage>}
    </Card>
  );
}

function SuggestionRow({
  suggestion,
  currency,
  canWrite,
  pending,
  apply,
}: {
  suggestion: SuggestionView;
  currency: string;
  canWrite: boolean;
  pending: boolean;
  apply: (input: { lines: Array<{ invoiceId: string; amount: string }>; fees: Array<{ invoiceId: string; amount: string; reason: string }>; suggestion?: SuggestionView }) => Promise<boolean>;
}) {
  const [reason, setReason] = useState("");
  const lines = suggestion.lines.map((line) => ({ invoiceId: line.invoiceId, amount: typed(line.amount) }));
  return (
    <div className="grid gap-2">
      <p className="flex items-start gap-2 text-sm leading-6 text-ink">
        <Sparkles aria-hidden className="mt-1 size-3.5 shrink-0 text-agent" />
        <span>{suggestion.why}</span>
      </p>
      <ul className="grid gap-0.5 pl-5 text-xs text-ink-2">
        {suggestion.lines.map((line) => (
          <li key={line.invoiceId}>
            {line.label}: <Money value={line.amount} token={currency} />
          </li>
        ))}
        {suggestion.fee && (
          <li>
            Possible fee on {suggestion.fee.label}: <Money value={suggestion.fee.amount} token={currency} />
          </li>
        )}
        {suggestion.creditLeft > 0 && (
          <li>
            Left as credit for {suggestion.customer}: <Money value={suggestion.creditLeft} token={currency} />
          </li>
        )}
      </ul>
      {canWrite &&
        (suggestion.fee ? (
          <form
            className="grid gap-2 pl-5 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              const fee = suggestion.fee as NonNullable<SuggestionView["fee"]>;
              void apply({ lines, fees: [{ invoiceId: fee.invoiceId, amount: typed(fee.amount), reason }], suggestion });
            }}
          >
            <Field id={`fee-reason-${suggestion.lines[0]?.invoiceId}`} label="Why the difference is a fee">
              <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={REASON_MAX} placeholder="Such as a bank's transfer fee" />
            </Field>
            <Button type="submit" size="sm" loading={pending} disabled={reason.trim() === ""}>
              Apply and record the fee
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => void apply({ lines, fees: [], suggestion })}>
              Apply, leave the rest owed
            </Button>
          </form>
        ) : (
          <div className="pl-5">
            <Button size="sm" loading={pending} onClick={() => void apply({ lines, fees: [], suggestion })}>
              Apply
            </Button>
          </div>
        ))}
    </div>
  );
}

function ApplyByHand({
  payment,
  pending,
  apply,
}: {
  payment: PaymentView;
  pending: boolean;
  apply: (input: { lines: Array<{ invoiceId: string; amount: string }>; fees: Array<{ invoiceId: string; amount: string; reason: string }> }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [fee, setFee] = useState<{ invoiceId: string; amount: string; reason: string }>({ invoiceId: "", amount: "", reason: "" });
  const total = Object.values(amounts).reduce((sum, value) => sum + (Number(value.replace(/,/g, "")) || 0), 0);
  const left = Math.max(0, payment.unapplied - total);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const lines = Object.entries(amounts)
      .filter(([, value]) => value.trim() !== "")
      .map(([invoiceId, amount]) => ({ invoiceId, amount: amount.trim() }));
    const fees = fee.invoiceId && fee.amount.trim() ? [{ invoiceId: fee.invoiceId, amount: fee.amount.trim(), reason: fee.reason }] : [];
    if (await apply({ lines, fees })) {
      setOpen(false);
      setAmounts({});
      setFee({ invoiceId: "", amount: "", reason: "" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" icon={<HandCoins />}>
          Apply by hand
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Apply ${typed(payment.unapplied)} ${payment.currency}`}
        description="Type how much goes to each invoice. What is not applied stays on the payment as the customer's credit, to apply later."
      >
        <form onSubmit={submit} className="grid gap-4">
          <ul className="grid max-h-80 gap-2 overflow-y-auto pr-1">
            {payment.choices.map((choice) => (
              <li key={choice.invoiceId} className="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-3">
                <label htmlFor={`apply-${payment.id}-${choice.invoiceId}`} className="min-w-0 text-sm text-ink">
                  <span className="block truncate">{choice.label}</span>
                  <span className="block text-xs text-ink-3">
                    {choice.customer}, {typed(choice.outstanding)} {payment.currency} owed, due {utcDay(choice.dueDate)}
                  </span>
                </label>
                <Input
                  id={`apply-${payment.id}-${choice.invoiceId}`}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amounts[choice.invoiceId] ?? ""}
                  onChange={(event) => setAmounts((current) => ({ ...current, [choice.invoiceId]: event.target.value }))}
                />
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-2">
            Left of the payment after this: {typed(left)} {payment.currency}
          </p>
          <Disclosure summary="Record a difference as a fee" className="text-sm">
            <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2">
              <Field id={`fee-invoice-${payment.id}`} label="On which invoice">
                <Select value={fee.invoiceId || NO_FEE} onValueChange={(value) => setFee((current) => ({ ...current, invoiceId: value === NO_FEE ? "" : value }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_FEE}>None</SelectItem>
                    {payment.choices.map((choice) => (
                      <SelectItem key={choice.invoiceId} value={choice.invoiceId}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field id={`fee-amount-${payment.id}`} label="Fee">
                <Input inputMode="decimal" placeholder="0.00" value={fee.amount} onChange={(event) => setFee((current) => ({ ...current, amount: event.target.value }))} />
              </Field>
              <Field id={`fee-why-${payment.id}`} label="Why it is a fee" className="sm:col-span-2">
                <Input maxLength={REASON_MAX} value={fee.reason} onChange={(event) => setFee((current) => ({ ...current, reason: event.target.value }))} />
              </Field>
            </div>
          </Disclosure>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button type="submit" loading={pending}>
              Apply
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
