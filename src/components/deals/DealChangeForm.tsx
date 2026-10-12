"use client";

import { GitBranch, Plus, Trash2, Wand2 } from "lucide-react";
import { useState } from "react";
import { changeDealAction, type DealActionResult } from "@/app/actions/deals";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { inForce, type DealFacts } from "@/lib/deals/lines";
import { formatMinor, minorToDecimal, parseMinor } from "@/lib/deals/money";
import { planRevision, proposeCorrection, type ProposedLine } from "@/lib/deals/revision";
import { changeWords } from "@/lib/deals/words";
import { MAX_LINES } from "@/lib/deals/schedule";
import { DealMoney } from "./DealMoney";

const INITIAL: DealActionResult = { ok: false, message: "" };

interface EditableLine {
  id?: string;
  kind: "charge" | "credit";
  label: string;
  invoiceOn: string;
  /** As typed, without a sign: a credit is owed back, so it counts negative. */
  amount: string;
}

/**
 * Change deal, or Reopen deal (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D7-D9): a new total and the
 * lines not invoiced yet, edited or proposed as a correction. The version is planned here as it is typed, with the same
 * function the server plans it with, so the difference and every change are shown before it is saved. Released lines
 * are not in the form: they stay as they are.
 */
export function DealChangeForm({
  orgSlug,
  facts,
  digits,
  today,
  idempotencyKey,
  mode,
}: {
  orgSlug: string;
  facts: DealFacts;
  digits: 0 | 2;
  today: string;
  idempotencyKey: string;
  mode: "revised" | "reopened";
}) {
  const planned = inForce(facts.lines)
    .filter((line) => line.status === "planned")
    .sort((a, b) => a.position - b.position);
  const toEditable = (lines: ProposedLine[]): EditableLine[] =>
    lines.map((line) => ({ ...(line.id ? { id: line.id } : {}), kind: line.kind, label: line.label, invoiceOn: line.invoiceOn, amount: minorToDecimal(Math.abs(line.amountMinor), digits) }));
  const [total, setTotal] = useState(minorToDecimal(facts.totalMinor, digits));
  // A cancelled deal's planned lines are the credits still owed to the customer (a cancel ends only the charges): a
  // reopen starts from them too, so it never drops money owed back unless the person removes it.
  const [lines, setLines] = useState<EditableLine[]>(toEditable(planned));
  const { state, formProps } = useActionForm(changeDealAction, INITIAL, { toastOnSuccess: true });

  const totalMinor = parseMinor(total, facts.currency);
  const proposed: ProposedLine[] = lines.map((line) => {
    const amount = parseMinor(line.amount, facts.currency) ?? -1;
    return { ...(line.id ? { id: line.id } : {}), kind: line.kind, label: line.label, invoiceOn: line.invoiceOn, amountMinor: line.kind === "credit" && amount > 0 ? -amount : amount };
  });
  const plan = totalMinor === null ? null : planRevision(facts, { kind: mode, totalMinor, lines: proposed });
  const money = (minor: number) => `${formatMinor(minor, digits)} ${facts.currency}`;
  const setLine = (index: number, patch: Partial<EditableLine>) => setLines(lines.map((line, at) => (at === index ? { ...line, ...patch } : line)));

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="dealId" value={facts.id} />
      <input type="hidden" name="baseVersion" value={facts.version} />
      <input type="hidden" name="kind" value={mode} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="lines" value={JSON.stringify(proposed)} />

      <div className="grid gap-4 sm:grid-cols-[14rem_minmax(0,1fr)]">
        <Field id="deal-change-total" label={`New total (${facts.currency})`}>
          <Input name="total" inputMode="decimal" value={total} onChange={(event) => setTotal(event.target.value)} />
        </Field>
        <Field id="deal-change-reason" label="Reason" optional description="Kept with the version and its signed entry.">
          <Input name="reason" maxLength={280} placeholder="Extra landing page agreed on Oct 12" />
        </Field>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-ink">Lines not invoiced yet</p>
          {mode === "revised" && (
            <Button type="button" size="sm" variant="secondary" icon={<Wand2 />} disabled={totalMinor === null} onClick={() => totalMinor !== null && setLines(toEditable(proposeCorrection(facts, totalMinor, today)))}>
              Propose a correction
            </Button>
          )}
        </div>
        {lines.length === 0 && <p className="text-xs text-ink-3">{mode === "reopened" ? "Add the lines still to invoice." : "No line is left to invoice."}</p>}
        {lines.map((line, index) => (
          <div key={line.id ?? `new-${index}`} className="grid grid-cols-[minmax(0,1fr)_9.5rem_8rem_auto] items-center gap-2">
            <span className="flex min-w-0 items-center gap-2">
              {line.kind === "credit" && (
                <Badge size="sm" tone="neutral">
                  Credit
                </Badge>
              )}
              <Input aria-label={`Line ${index + 1} name`} size="sm" maxLength={80} value={line.label} onChange={(event) => setLine(index, { label: event.target.value })} />
            </span>
            <Input aria-label={`Line ${index + 1} invoice day`} size="sm" type="date" value={line.invoiceOn} onChange={(event) => setLine(index, { invoiceOn: event.target.value })} />
            <Input aria-label={`Line ${index + 1} amount`} size="sm" inputMode="decimal" className="text-right" value={line.amount} onChange={(event) => setLine(index, { amount: event.target.value })} />
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${index + 1}`} onClick={() => setLines(lines.filter((_, at) => at !== index))}>
              <Trash2 aria-hidden />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<Plus />}
          disabled={lines.length >= MAX_LINES}
          onClick={() => setLines([...lines, { kind: "charge", label: "", invoiceOn: lines.at(-1)?.invoiceOn ?? (today > facts.startsOn ? today : facts.startsOn), amount: "" }])}
        >
          Add a line
        </Button>
      </div>

      <div aria-live="polite" className="rounded-xl border border-line bg-raised/40 p-3 text-[0.8125rem]">
        {plan === null ? (
          <p className="text-ink-3">Type the new total.</p>
        ) : plan.ok ? (
          <>
            <p className="text-ink">
              Version {plan.revision.toVersion}: <DealMoney minor={plan.revision.fromTotalMinor} digits={digits} currency={facts.currency} /> to{" "}
              <DealMoney minor={plan.revision.toTotalMinor} digits={digits} currency={facts.currency} /> (difference{" "}
              <DealMoney minor={plan.revision.differenceMinor} digits={digits} currency={facts.currency} sign />)
            </p>
            {plan.revision.changes.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">
                {plan.revision.changes.map((change, index) => (
                  <li key={index}>{changeWords(change, money)}</li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-xs text-ink-3">Lines already released, and their receivables, stay as they are.</p>
          </>
        ) : (
          <p className="text-held">{plan.message}</p>
        )}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
        <SubmitButton icon={<GitBranch />} disabled={!plan?.ok} pendingLabel="Saving…" className="shrink-0">
          {mode === "reopened" ? `Reopen as version ${facts.version + 1}` : `Save as version ${facts.version + 1}`}
        </SubmitButton>
      </div>
    </form>
  );
}
