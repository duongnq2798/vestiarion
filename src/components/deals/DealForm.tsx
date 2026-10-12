"use client";

import { Handshake, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createDealAction, type DealActionResult } from "@/app/actions/deals";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { useActionForm } from "@/components/ui/useActionForm";
import { orgHref } from "@/lib/auth/org-paths";
import { utcDay } from "@/lib/copy";
import { templateInputOf, type DealFormField } from "@/lib/deals/input";
import { dealDigits, formatMinor, minorToDecimal, parseMinor } from "@/lib/deals/money";
import { addDays, buildSchedule, checkLines, DEFAULT_TERMS_DAYS, MAX_LINES, MAX_MILESTONES, type ScheduleLine } from "@/lib/deals/schedule";
import { DealMoney } from "./DealMoney";

const INITIAL: DealActionResult = { ok: false, message: "" };

const TEMPLATES = [
  { value: "deposit", label: "Deposit and balance", description: "A percent when the deal starts, the rest on the delivery date." },
  { value: "milestones", label: "Equal milestones", description: "The total in equal parts, each on its own date." },
  { value: "retainer", label: "Monthly retainer", description: "The total in equal months, on a day of the month." },
  { value: "custom", label: "Custom lines", description: "Each line with its own name, day and amount." },
] as const;

/** A line as the person edits it: the amount as typed. */
interface EditedLine {
  label: string;
  invoiceOn: string;
  amount: string;
}

const dayWords = (day: string) => (/^\d{4}-\d{2}-\d{2}$/.test(day) ? utcDay(`${day}T00:00:00.000Z`) : "—");

/**
 * The form filled in from a CRM's won deal (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H11): the
 * person picks how it is billed, checks the rest and confirms. Its row travels with the form, and the server reads it
 * again; the CRM's deal id is the reference, not editable here.
 */
export interface DealFormPrefill {
  crmRowId: string;
  /** The CRM's name in copy. */
  label: string;
  customerId: string;
  customerName: string;
  title: string;
  total: string;
  currency: string;
  startsOn: string;
  externalRef: string;
  notes: string[];
}

/**
 * The New deal form (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D4-D6, D12): who the customer is, the
 * deal's terms, and its schedule, built from a template the person picks and can then edit line by line. The schedule
 * is worked out here as it is typed, with the same functions the server checks it with, so what is shown is what is
 * confirmed. A key made when the page was drawn travels with the form, so confirming twice makes one deal.
 */
export function DealForm({
  orgSlug,
  customers,
  currencies,
  idempotencyKey,
  today,
  initialCustomerId,
  prefill,
}: {
  orgSlug: string;
  customers: Array<{ id: string; name: string }>;
  /** USDC and EURC, and the business's own currency in shadow mode. */
  currencies: string[];
  idempotencyKey: string;
  today: string;
  /** The customer chosen to start with: a guide's screenshot. */
  initialCustomerId?: string;
  /** The form filled in from a CRM's won deal (HubSpot connector H11). */
  prefill?: DealFormPrefill;
}) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState(prefill?.customerId || initialCustomerId || (customers.length === 0 ? "new" : ""));
  const [currency, setCurrency] = useState(prefill?.currency ?? currencies[0] ?? "USDC");
  const [total, setTotal] = useState(prefill?.total ?? "");
  const [startsOn, setStartsOn] = useState(prefill?.startsOn ?? today);
  const [termsDays, setTermsDays] = useState(String(DEFAULT_TERMS_DAYS));
  const [template, setTemplate] = useState<(typeof TEMPLATES)[number]["value"]>("deposit");
  const [depositPct, setDepositPct] = useState("30");
  const [deliveryOn, setDeliveryOn] = useState("");
  const [milestones, setMilestones] = useState<Array<{ label: string; invoiceOn: string }>>([
    { label: "", invoiceOn: today },
    { label: "", invoiceOn: "" },
    { label: "", invoiceOn: "" },
  ]);
  const [months, setMonths] = useState("12");
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [edited, setEdited] = useState<EditedLine[] | null>(null);

  const { state, formProps } = useActionForm(createDealAction, INITIAL, {
    toastOnSuccess: true,
    onSuccess: (result) => {
      if (result.dealId) router.push(orgHref(orgSlug, `/invoices/deals/${result.dealId}`));
    },
  });

  const digits = dealDigits(currency);
  const totalMinor = parseMinor(total, currency);
  const terms = /^\d{1,3}$/.test(termsDays.trim()) ? Number(termsDays.trim()) : DEFAULT_TERMS_DAYS;
  const templateInput = templateInputOf({ template, depositPct, deliveryOn, milestones: JSON.stringify(milestones), months, dayOfMonth, lines: "[]" });
  const built = totalMinor !== null && template !== "custom" && templateInput ? buildSchedule({ totalMinor, currency, startsOn, termsDays: terms, template: templateInput }) : null;
  const lines: EditedLine[] | null = edited ?? (template === "custom" ? [{ label: "", invoiceOn: startsOn, amount: "" }] : null);
  const postedLines = (lines ?? []).map((line) => ({ label: line.label, invoiceOn: line.invoiceOn, amountMinor: parseMinor(line.amount, currency) ?? -1 }));
  const editedProblem = lines && totalMinor !== null ? checkLines(postedLines, { totalMinor, currency, startsOn }) : null;
  const shown: ScheduleLine[] = lines
    ? postedLines.map((line, index) => ({ position: index + 1, kind: "charge", label: line.label, invoiceOn: line.invoiceOn, dueOn: /^\d{4}-\d{2}-\d{2}$/.test(line.invoiceOn) ? addDays(line.invoiceOn, terms) : "", amountMinor: line.amountMinor, roundingMinor: 0 }))
    : built?.ok
      ? built.lines
      : [];
  const sum = postedLines.reduce((acc, line) => acc + Math.max(0, line.amountMinor), 0);
  const error = (field: DealFormField) => (!state.ok && state.field === field ? state.message : undefined);

  const editLines = () => setEdited(shown.map((line) => ({ label: line.label, invoiceOn: line.invoiceOn, amount: minorToDecimal(line.amountMinor, digits) })));
  const setLine = (index: number, patch: Partial<EditedLine>) => setEdited((current) => (current ?? lines ?? []).map((line, at) => (at === index ? { ...line, ...patch } : line)));

  return (
    <form {...formProps} className="space-y-5">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {prefill && <input type="hidden" name="crmRowId" value={prefill.crmRowId} />}
      {prefill && prefill.notes.length > 0 && (
        <Callout title={`Filled in from ${prefill.label}`}>
          <ul className="list-disc space-y-1 pl-5">
            {prefill.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Callout>
      )}
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="currency" value={currency} />
      <input type="hidden" name="template" value={template} />
      <input type="hidden" name="milestones" value={JSON.stringify(milestones)} />
      <input type="hidden" name="lines" value={JSON.stringify(postedLines)} />
      <input type="hidden" name="edited" value={lines ? "1" : ""} />
      {/* The template's inputs always travel, so the server builds it again and keeps the rounding of a line still as built. */}
      <input type="hidden" name="depositPct" value={depositPct} />
      <input type="hidden" name="deliveryOn" value={deliveryOn} />
      <input type="hidden" name="months" value={months} />
      <input type="hidden" name="dayOfMonth" value={dayOfMonth} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="deal-customer" label="Customer" error={error("customerId")}>
          <Select value={customerId} onValueChange={setCustomerId}>
            <SelectTrigger>
              <SelectValue placeholder="Select a customer" />
            </SelectTrigger>
            <SelectContent>
              {customers.map((customer) => (
                <SelectItem key={customer.id} value={customer.id}>
                  {customer.name}
                </SelectItem>
              ))}
              <SelectItem value="new">New customer…</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {customerId === "new" ? (
          <Field id="deal-customer-name" label="New customer's name" error={error("customerName")} description="Added as a client, and screened as every counterparty is.">
            <Input name="customerName" maxLength={160} placeholder="Northwind Labs" required defaultValue={prefill?.customerName || undefined} />
          </Field>
        ) : (
          <div className="hidden sm:block" />
        )}
        <Field id="deal-title" label="Deal" error={error("title")}>
          <Input name="title" maxLength={120} required placeholder="Website rebuild" defaultValue={prefill?.title} />
        </Field>
        {prefill ? (
          <Field id="deal-ref" label="External reference" description={`${prefill.label}'s deal id: it links this deal to ${prefill.label}.`} error={error("externalRef")}>
            <Input name="externalRef" readOnly value={prefill.externalRef} />
          </Field>
        ) : (
          <Field id="deal-ref" label="External reference" optional description="Your CRM's deal id, for instance. Unique in this workspace." error={error("externalRef")}>
            <Input name="externalRef" maxLength={200} placeholder="HS-48213" />
          </Field>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
          <Field id="deal-total" label="Total" error={error("total")}>
            <Input name="total" inputMode="decimal" required value={total} onChange={(event) => setTotal(event.target.value)} placeholder={digits === 0 ? "1,000,000" : "10,000.00"} />
          </Field>
          <Field id="deal-currency" label="Currency" error={error("currency")}>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {currencies.map((code) => (
                  <SelectItem key={code} value={code}>
                    {code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field id="deal-starts" label="Start date" error={error("startsOn")}>
            <Input name="startsOn" type="date" required value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />
          </Field>
          <Field id="deal-terms" label="Payment terms (days)" error={error("termsDays")}>
            <Input name="termsDays" inputMode="numeric" value={termsDays} onChange={(event) => setTermsDays(event.target.value)} />
          </Field>
        </div>
      </div>

      <RadioGroup
        legend="How it is billed"
        value={template}
        onValueChange={(value) => {
          setTemplate(value as typeof template);
          setEdited(null);
        }}
        options={TEMPLATES}
        className="sm:[&>[role=radiogroup]]:grid-cols-2"
      />

      {!lines && template === "deposit" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="deal-deposit" label="Deposit (%)" error={error("depositPct")}>
            <Input inputMode="decimal" value={depositPct} onChange={(event) => setDepositPct(event.target.value)} />
          </Field>
          <Field id="deal-delivery" label="Delivery date" error={error("deliveryOn")} description="The balance is invoiced on this day.">
            <Input type="date" value={deliveryOn} onChange={(event) => setDeliveryOn(event.target.value)} />
          </Field>
        </div>
      )}
      {!lines && template === "milestones" && (
        <div className="space-y-2">
          {milestones.map((milestone, index) => (
            <div key={index} className="grid grid-cols-[minmax(0,1fr)_10rem_auto] items-end gap-2">
              <Field id={`deal-milestone-${index}`} label={`Milestone ${index + 1}`} optional>
                <Input value={milestone.label} maxLength={80} placeholder={`Milestone ${index + 1} of ${milestones.length}`} onChange={(event) => setMilestones(milestones.map((each, at) => (at === index ? { ...each, label: event.target.value } : each)))} />
              </Field>
              <Field id={`deal-milestone-day-${index}`} label="Invoice day">
                <Input type="date" value={milestone.invoiceOn} onChange={(event) => setMilestones(milestones.map((each, at) => (at === index ? { ...each, invoiceOn: event.target.value } : each)))} />
              </Field>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove milestone ${index + 1}`} disabled={milestones.length <= 2} onClick={() => setMilestones(milestones.filter((_, at) => at !== index))}>
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}
          <Button type="button" variant="secondary" size="sm" disabled={milestones.length >= MAX_MILESTONES} onClick={() => setMilestones([...milestones, { label: "", invoiceOn: "" }])}>
            <Plus aria-hidden />
            Add a milestone
          </Button>
        </div>
      )}
      {!lines && template === "retainer" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="deal-months" label="Months" error={error("months")}>
            <Input inputMode="numeric" value={months} onChange={(event) => setMonths(event.target.value)} />
          </Field>
          <Field id="deal-day" label="Day of the month" error={error("dayOfMonth")} description="31 is each month's last day when it is shorter.">
            <Input inputMode="numeric" value={dayOfMonth} onChange={(event) => setDayOfMonth(event.target.value)} />
          </Field>
        </div>
      )}

      <section aria-labelledby="deal-schedule-title" className="rounded-xl border border-line bg-raised/40 p-3 sm:p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="deal-schedule-title" className="text-sm font-semibold text-ink">
            Schedule
          </h3>
          {lines ? (
            template !== "custom" && (
              <Button type="button" variant="link" className="text-xs" onClick={() => setEdited(null)}>
                Back to the template
              </Button>
            )
          ) : (
            shown.length > 0 && (
              <Button type="button" variant="link" className="text-xs" onClick={editLines}>
                Edit lines
              </Button>
            )
          )}
        </div>
        {shown.length === 0 && !lines ? (
          <p className="mt-2 text-xs text-ink-3">{built && !built.ok ? built.message : "Type the total and how it is billed, and the lines read back here."}</p>
        ) : (
          <Table label="The deal's lines" containerClassName="mt-2">
            <TableHeader>
              <TableRow>
                <TableHead className="px-2">Line</TableHead>
                <TableHead className="px-2">Invoice day</TableHead>
                <TableHead className="px-2">Due</TableHead>
                <TableHead className="px-2 text-right">Amount</TableHead>
                {lines && <TableHead className="px-2"><span className="sr-only">Remove</span></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((line, index) => (
                <TableRow key={index}>
                  <TableCell className="px-2 py-1.5">
                    {lines ? (
                      <Input aria-label={`Line ${index + 1} name`} size="sm" maxLength={80} value={lines[index].label} onChange={(event) => setLine(index, { label: event.target.value })} />
                    ) : (
                      <span className="text-[0.8125rem] text-ink">{line.label}</span>
                    )}
                  </TableCell>
                  <TableCell className="px-2 py-1.5">
                    {lines ? (
                      <Input aria-label={`Line ${index + 1} invoice day`} size="sm" type="date" value={lines[index].invoiceOn} onChange={(event) => setLine(index, { invoiceOn: event.target.value })} />
                    ) : (
                      <span className="font-mono text-xs text-ink-2">{dayWords(line.invoiceOn)}</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-2 py-1.5 font-mono text-xs text-ink-3">{dayWords(line.dueOn)}</TableCell>
                  <TableCell className="px-2 py-1.5 text-right">
                    {lines ? (
                      <Input aria-label={`Line ${index + 1} amount`} size="sm" inputMode="decimal" className="text-right" value={lines[index].amount} onChange={(event) => setLine(index, { amount: event.target.value })} />
                    ) : (
                      <>
                        <DealMoney minor={line.amountMinor} digits={digits} currency={currency} className="text-[0.8125rem] text-ink" />
                        {line.roundingMinor > 0 && (
                          <span className="block text-[0.6875rem] text-ink-3">
                            Includes {formatMinor(line.roundingMinor, digits)} from rounding
                          </span>
                        )}
                      </>
                    )}
                  </TableCell>
                  {lines && (
                    <TableCell className="px-1 py-1.5">
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${index + 1}`} disabled={lines.length <= 1} onClick={() => setEdited(lines.filter((_, at) => at !== index))}>
                        <Trash2 aria-hidden />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {lines && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={lines.length >= MAX_LINES} onClick={() => setEdited([...lines, { label: "", invoiceOn: lines.at(-1)?.invoiceOn ?? startsOn, amount: "" }])}>
              <Plus aria-hidden />
              Add a line
            </Button>
            <p aria-live="polite" className={editedProblem?.code === "sum" ? "text-xs font-medium text-held" : "text-xs text-ink-3"}>
              {totalMinor === null
                ? "Type the total first."
                : editedProblem
                  ? editedProblem.message
                  : `The lines add up to the total: ${formatMinor(sum, digits)} ${currency}.`}
            </p>
          </div>
        )}
      </section>

      <Checkbox
        name="autoRelease"
        label="Release each line on its invoice day"
        description="The agent makes each line a receivable on its day, as you would with Release now. Off, a person releases each line."
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
        <SubmitButton icon={<Handshake />} pendingLabel="Confirming…" className="shrink-0">
          Confirm deal
        </SubmitButton>
      </div>
    </form>
  );
}
