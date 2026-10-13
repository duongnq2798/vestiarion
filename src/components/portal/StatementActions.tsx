"use client";

import { CalendarClock, CircleCheck, Link2, MessageSquareWarning, Send, Wallet } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { submitStatementRequestAction, replyOnStatementAction, type StatementActionResult } from "@/app/statement/[token]/actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { cn } from "@/components/ui/cn";

/**
 * What a customer can do about one open invoice on its statement (docs/superpowers/specs/2026-10-13-customer-portal-
 * design.md P4, I16): pay it through its pay link, ask for one, say it paid, promise a day, or dispute it. Each form
 * opens under the buttons and repeats what is owed, in its currency, so the amount stays in view with the phone's
 * keyboard up; fields are 16 px text and buttons at least 44 px tall on a phone. No wallet is needed for any of it.
 */

export type StatementForm = "paid" | "promise" | "dispute";

const INITIAL: StatementActionResult = { ok: false, message: "" };

export interface StatementInvoiceProps {
  token: string;
  invoiceId: string;
  label: string;
  /** What is still owed, formatted: "750.00". */
  owed: string;
  currency: string;
  orgName: string;
  /** Today, the latest day paid (a day ahead of UTC is still today somewhere) and the furthest day a promise may name, YYYY-MM-DD (UTC). */
  today: string;
  latestPaid: string;
  latestPromise: string;
  payUrl: string | null;
  /** Whether "Ask for a pay link" is offered: no pay link, and none asked for already. */
  canAskPayLink: boolean;
  /** A form shown open, for pictures of the page. */
  defaultOpen?: StatementForm | null;
}

const BUTTONS: Array<{ form: StatementForm; label: string; icon: ReactNode }> = [
  { form: "paid", label: "I paid", icon: <CircleCheck /> },
  { form: "promise", label: "Promise to pay", icon: <CalendarClock /> },
  { form: "dispute", label: "Dispute", icon: <MessageSquareWarning /> },
];

export function StatementActions(props: StatementInvoiceProps) {
  const [open, setOpen] = useState<StatementForm | null>(props.defaultOpen ?? null);
  const [sent, setSent] = useState<string | null>(null);
  const panelId = useId();

  return (
    <div className="mt-4 space-y-3">
      {sent && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-proof-line bg-proof-soft px-3 py-2.5 text-sm text-proof">
          <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{sent}</span>
        </p>
      )}
      <div className="grid gap-2 sm:flex sm:flex-wrap">
        {props.payUrl ? (
          <Button asChild size="lg" className="w-full sm:w-auto">
            <a href={props.payUrl}>
              <Wallet aria-hidden className="size-[1.125rem]" />
              Pay on Arc
            </a>
          </Button>
        ) : props.canAskPayLink ? (
          <AskPayLink {...props} onSent={setSent} />
        ) : null}
        {BUTTONS.map((button) => (
          <Button
            key={button.form}
            variant="secondary"
            size="lg"
            // The open form's button stays secondary, marked rather than filled, so it never reads as Pay on Arc.
            className={cn("w-full sm:w-auto", open === button.form && "border-agent bg-agent-soft text-agent")}
            icon={button.icon}
            aria-expanded={open === button.form}
            aria-controls={panelId}
            onClick={() => {
              setSent(null);
              setOpen(open === button.form ? null : button.form);
            }}
          >
            {button.label}
          </Button>
        ))}
      </div>
      <div id={panelId}>
        {open && (
          <StatementFormPanel
            key={open}
            form={open}
            {...props}
            onClose={() => setOpen(null)}
            onSent={(message) => {
              setOpen(null);
              setSent(message);
            }}
          />
        )}
      </div>
    </div>
  );
}

function AskPayLink(props: StatementInvoiceProps & { onSent: (message: string) => void }) {
  const ask = useActionForm(submitStatementRequestAction, INITIAL, { onSuccess: (state) => props.onSent(state.message) });
  return (
    <form {...ask.formProps} className="contents">
      <input type="hidden" name="token" value={props.token} />
      <input type="hidden" name="invoiceId" value={props.invoiceId} />
      <input type="hidden" name="kind" value="pay_link" />
      <SubmitButton size="lg" variant="secondary" className="w-full sm:w-auto" icon={<Link2 />} pendingLabel="Asking…">
        Ask for a pay link
      </SubmitButton>
      {!ask.state.ok && ask.state.message && <FormMessage tone="error" className="sm:basis-full">{ask.state.message}</FormMessage>}
    </form>
  );
}

const TITLES: Record<StatementForm, string> = {
  paid: "Tell them you paid",
  promise: "Promise a day to pay",
  dispute: "Dispute this invoice",
};

function StatementFormPanel(props: StatementInvoiceProps & { form: StatementForm; onClose: () => void; onSent: (message: string) => void }) {
  const { form, token, invoiceId, owed, currency, label, today, latestPaid, latestPromise } = props;
  const submit = useActionForm(submitStatementRequestAction, INITIAL, { onSuccess: (state) => props.onSent(state.message) });
  const errorOf = (field: string) => (!submit.state.ok && submit.state.field === field ? submit.state.message : undefined);
  const formError = !submit.state.ok && submit.state.message && (!submit.state.field || submit.state.field === "form") ? submit.state.message : null;
  const id = (name: string) => `${invoiceId}-${form}-${name}`;

  return (
    <section aria-labelledby={id("title")} className="rounded-xl border border-line-strong bg-ground p-4 sm:p-5">
      <h4 id={id("title")} className="text-[0.9375rem] font-semibold text-ink">
        {TITLES[form]}
      </h4>
      {/* What is owed stays in view above the fields, whatever the keyboard covers below. */}
      <p className="mt-1 text-sm text-ink-2">
        <span className="font-semibold tabular-nums text-ink">
          {owed} {currency}
        </span>{" "}
        still owed on <span className="break-words">{label}</span>
      </p>
      <form {...submit.formProps} className="mt-4 grid gap-4" noValidate>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="invoiceId" value={invoiceId} />
        <input type="hidden" name="kind" value={form} />
        {form === "paid" && (
          <>
            <Field id={id("paidOn")} label="Day you paid" error={errorOf("paidOn")}>
              <Input name="paidOn" type="date" defaultValue={today} max={latestPaid} required autoFocus />
            </Field>
            <Field id={id("amount")} label="Amount you paid" optional description="Leave it as it is if you paid all that is owed." error={errorOf("amount")}>
              <AmountInput name="amount" defaultValue={owed} currency={currency} />
            </Field>
            <Field id={id("reference")} label="Payment reference" optional description="A bank reference or the transaction hash helps them find your payment." error={errorOf("reference")}>
              <Input name="reference" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={120} />
            </Field>
            <Field id={id("message")} label="Note" optional error={errorOf("message")}>
              <Textarea name="message" rows={3} maxLength={2000} />
            </Field>
          </>
        )}
        {form === "promise" && (
          <>
            <Field id={id("promisedOn")} label="Day you will pay" description="Reminders about this invoice wait until then." error={errorOf("promisedOn")}>
              <Input name="promisedOn" type="date" min={today} max={latestPromise} required autoFocus />
            </Field>
            <Field id={id("message")} label="Note" optional error={errorOf("message")}>
              <Textarea name="message" rows={3} maxLength={2000} />
            </Field>
          </>
        )}
        {form === "dispute" && (
          <Field
            id={id("message")}
            label="What is wrong with this invoice?"
            description={`${props.orgName} reads it and replies on this page. Reminders about this invoice wait until they resolve it.`}
            error={errorOf("message")}
          >
            <Textarea name="message" rows={4} maxLength={2000} required autoFocus />
          </Field>
        )}
        <FormMessage tone="error">{formError}</FormMessage>
        <div className="grid gap-2 sm:flex sm:flex-row-reverse sm:justify-start">
          <SubmitButton size="lg" className="w-full sm:w-auto" icon={<Send />} pendingLabel="Sending…">
            {form === "paid" ? "Send" : form === "promise" ? "Send promise" : "Send dispute"}
          </SubmitButton>
          <Button variant="ghost" size="lg" className="w-full sm:w-auto" onClick={props.onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}

/** An amount field that shows its currency inside it, so the two are never apart. */
function AmountInput({ name, defaultValue, currency }: { name: string; defaultValue: string; currency: string }) {
  return (
    <div className="relative">
      <Input name={name} inputMode="decimal" autoComplete="off" defaultValue={defaultValue} className="pr-16 tabular-nums" />
      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm font-semibold text-ink-2">
        {currency}
      </span>
    </div>
  );
}

/** The customer writes more under one of its open requests. */
export function StatementReply({ token, requestId, orgName }: { token: string; requestId: string; orgName: string }) {
  const [open, setOpen] = useState(false);
  const fieldId = useId();
  const reply = useActionForm(replyOnStatementAction, INITIAL, { resetOnSuccess: true, onSuccess: () => setOpen(false) });
  if (!open) {
    return (
      <div className="space-y-1">
        <Button variant="link" className="min-h-11 text-[0.8125rem] sm:min-h-0" onClick={() => setOpen(true)}>
          Write to {orgName}
        </Button>
        {reply.state.ok && reply.state.message && <FormMessage tone="success">{reply.state.message}</FormMessage>}
      </div>
    );
  }
  return (
    <form {...reply.formProps} className="grid gap-2">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="requestId" value={requestId} />
      <Field id={fieldId} label={`Your message to ${orgName}`} error={!reply.state.ok && reply.state.field === "message" ? reply.state.message : undefined}>
        <Textarea name="message" rows={3} maxLength={2000} required autoFocus />
      </Field>
      <FormMessage tone="error">{!reply.state.ok && reply.state.message && reply.state.field !== "message" ? reply.state.message : null}</FormMessage>
      <div className="grid gap-2 sm:flex">
        <SubmitButton size="md" className="w-full sm:w-auto" icon={<Send />} pendingLabel="Sending…">
          Send
        </SubmitButton>
        <Button variant="ghost" size="md" className="w-full sm:w-auto" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
