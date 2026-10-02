"use client";

import { Repeat, Square } from "lucide-react";
import { useState, type FormEvent } from "react";
import { createRecurringPayableAction, stopRecurringPayableAction, type RecurringActionResult } from "@/app/actions/recurring";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { Money } from "@/components/vx/Primitives";
import { utcDay } from "@/lib/copy";
import { scheduleSummary } from "@/lib/recurring";
import type { RecurringPayableView } from "@/lib/recurring-payables";
import type { IntakeCounterparty } from "./InvoiceIntake";

const INITIAL: RecurringActionResult = { ok: false, message: "" };

/**
 * A recurring payment (docs/superpowers/specs/2026-10-02-recurring-payables-design.md §2): who, how
 * much, what for, how often and from when. Each period's invoice is created as it comes near and
 * decided by the agent like any other.
 */
export default function RecurringPayableIntake({ counterparties, orgSlug }: { counterparties: IntakeCounterparty[]; orgSlug: string }) {
  const [summary, setSummary] = useState<string | null>(null);
  const { state, formProps } = useActionForm(createRecurringPayableAction, INITIAL, { resetOnSuccess: true, toastOnSuccess: true, onSuccess: () => setSummary(null) });
  const payees = counterparties.filter((counterparty) => counterparty.role !== "client");
  const none = payees.length === 0;
  // Read back on every change, so the schedule is in words before it is set up.
  const describe = (event: FormEvent<HTMLFormElement>) => {
    const data = new FormData(event.currentTarget);
    const field = (key: string) => {
      const value = data.get(key);
      return typeof value === "string" ? value : "";
    };
    setSummary(
      scheduleSummary({
        payee: payees.find((counterparty) => counterparty.id === field("counterpartyId"))?.name ?? null,
        amount: field("amount"),
        currency: field("currency"),
        everyCount: field("everyCount"),
        everyUnit: field("everyUnit"),
        startsOn: field("startsOn"),
        endsOn: field("endsOn"),
      })
    );
  };
  return (
    <form {...formProps} onChange={describe} onInput={describe} className="space-y-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="recurring-counterparty" label="Pay" description={none ? "Add a vendor or contractor first." : undefined}>
          <Select name="counterpartyId" required disabled={none}>
            <SelectTrigger>
              <SelectValue placeholder="Select a vendor or contractor" />
            </SelectTrigger>
            <SelectContent>
              {payees.map((counterparty) => (
                <SelectItem key={counterparty.id} value={counterparty.id}>
                  {counterparty.name} · {counterparty.role}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="recurring-memo" label="For" description="Each period's invoice is named after it, with its date.">
          <Input name="memo" required maxLength={160} placeholder="Monthly design retainer" />
        </Field>
        <Field id="recurring-amount" label="Amount each period">
          <Input name="amount" required inputMode="decimal" placeholder="250.00" />
        </Field>
        <Field id="recurring-currency" label="Currency">
          <Select name="currency" defaultValue="USDC">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="USDC">USDC</SelectItem>
              <SelectItem value="EURC">EURC</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <div className="grid grid-cols-[6rem_1fr] gap-3">
          <Field id="recurring-every" label="Every">
            <Input name="everyCount" required inputMode="numeric" defaultValue="1" />
          </Field>
          <Field id="recurring-unit" label="Period">
            <Select name="everyUnit" defaultValue="month">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">day(s)</SelectItem>
                <SelectItem value="week">week(s)</SelectItem>
                <SelectItem value="month">month(s)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field id="recurring-po" label="Contract or PO reference" optional>
          <Input name="poReference" maxLength={100} placeholder="PO-2026-RET" />
        </Field>
        <Field id="recurring-starts" label="First due date">
          <Input name="startsOn" required type="date" />
        </Field>
        <Field id="recurring-ends" label="Last due date" optional description="Leave empty to keep paying until you stop it.">
          <Input name="endsOn" type="date" />
        </Field>
      </div>
      <Checkbox
        name="goodsReceived"
        defaultChecked
        label="Delivered every period"
        description="Each period's invoice counts as received, as you confirm the work or service continues. Untick it to confirm each period yourself."
      />
      <p aria-live="polite" className="flex items-start gap-2 rounded-xl border border-line bg-raised px-3 py-2.5 text-sm text-ink">
        <Repeat aria-hidden className="mt-0.5 size-4 shrink-0 text-agent" />
        <span>{summary ?? "Choose who is paid, how much, how often and from when, and the schedule reads back here."}</span>
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
        <SubmitButton icon={<Repeat />} disabled={none} pendingLabel="Setting up…" className="shrink-0">
          Set up recurring payment
        </SubmitButton>
      </div>
    </form>
  );
}

const STATUS: Record<RecurringPayableView["status"], { tone: "agent" | "neutral"; label: string }> = {
  active: { tone: "agent", label: "Running" },
  stopped: { tone: "neutral", label: "Stopped" },
  ended: { tone: "neutral", label: "Ended" },
};

/** The workspace's recurring payments: each one's cadence, next due date and status, and Stop for an owner or admin. */
export function RecurringPayablesList({ schedules, orgSlug, canWrite }: { schedules: RecurringPayableView[]; orgSlug: string; canWrite: boolean }) {
  return (
    <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
      {schedules.map((schedule) => (
        <li key={schedule.id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="min-w-0 space-y-1">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink">
              <span className="font-medium [overflow-wrap:anywhere]">{schedule.counterpartyName}</span>
              <span className="text-ink-3">·</span>
              <span className="[overflow-wrap:anywhere]">{schedule.memo}</span>
              <Badge tone={STATUS[schedule.status].tone} size="sm" dot>
                {STATUS[schedule.status].label}
              </Badge>
            </p>
            <p className="text-xs text-ink-3">
              <Money value={schedule.amount} token={schedule.currency} className="text-ink-2" /> {schedule.cadence}
              {schedule.nextDueOn ? ` · next due ${utcDay(`${schedule.nextDueOn}T00:00:00Z`)}` : ""}
              {schedule.endsOn ? ` · last ${utcDay(`${schedule.endsOn}T00:00:00Z`)}` : ""}
            </p>
          </div>
          {canWrite && schedule.status === "active" && <StopForm orgSlug={orgSlug} id={schedule.id} />}
        </li>
      ))}
    </ul>
  );
}

function StopForm({ orgSlug, id }: { orgSlug: string; id: string }) {
  const { state, formProps } = useActionForm(stopRecurringPayableAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex shrink-0 flex-col items-stretch gap-1 sm:items-end">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="recurringId" value={id} />
      <SubmitButton variant="secondary" size="sm" icon={<Square />} pendingLabel="Stopping…">
        Stop
      </SubmitButton>
      {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}
