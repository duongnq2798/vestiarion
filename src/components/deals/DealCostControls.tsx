"use client";

import { Link2, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { addDealCostAction, linkDealCostAction, removeDealCostAction, type DealCostActionResult } from "@/app/actions/deals";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { CostFormField } from "@/lib/deals/costs";
import { dealDigits } from "@/lib/deals/money";

const INITIAL: DealCostActionResult = { ok: false, message: "" };

/**
 * Add a cost (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md K1): what it is, who it is for, the amount
 * in the deal's currency, the day it is expected to leave, and whether a document backs it yet. A key made when the page
 * was drawn travels with the form, so sending it twice adds one cost.
 */
export function AddCostForm({
  orgSlug,
  dealId,
  currency,
  today,
  idempotencyKey,
  payees,
}: {
  orgSlug: string;
  dealId: string;
  currency: string;
  today: string;
  idempotencyKey: string;
  /** The workspace's vendors and contractors. */
  payees: Array<{ id: string; name: string }>;
}) {
  const [payee, setPayee] = useState("none");
  const { state, formProps } = useActionForm(addDealCostAction, INITIAL, { toastOnSuccess: true, resetOnSuccess: true, onSuccess: () => setPayee("none") });
  const error = (field: CostFormField) => (!state.ok && state.field === field ? state.message : undefined);
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="dealId" value={dealId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="counterpartyId" value={payee} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="cost-label" label="What it is" error={error("label")}>
          <Input name="label" maxLength={80} required placeholder="Contractor: design" />
        </Field>
        <Field id="cost-payee" label="Who it is for" optional error={error("counterpartyId")}>
          <Select value={payee} onValueChange={setPayee}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nobody named yet</SelectItem>
              {payees.map((each) => (
                <SelectItem key={each.id} value={each.id}>
                  {each.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="cost-amount" label={`Amount (${currency})`} error={error("amount")}>
          <Input name="amount" inputMode="decimal" required placeholder={dealDigits(currency) === 0 ? "100,000" : "1,240.00"} />
        </Field>
        <Field id="cost-day" label="Expected to leave on" error={error("expectedOn")}>
          <Input name="expectedOn" type="date" required defaultValue={today} />
        </Field>
      </div>
      <Checkbox name="noDocument" label="No document yet" description="No bill or quote backs it yet: it is counted, and named as such." />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FormMessage tone="error">{state.ok || state.field ? null : state.message}</FormMessage>
        <SubmitButton icon={<Plus />} pendingLabel="Adding…" className="shrink-0">
          Add cost
        </SubmitButton>
      </div>
    </form>
  );
}

/** Remove: the cost is kept with who removed it, and counted nowhere. Asked first. */
export function RemoveCostButton({ orgSlug, dealId, costId, label }: { orgSlug: string; dealId: string; costId: string; label: string }) {
  const formId = useId();
  const { state, formProps } = useActionForm(removeDealCostAction, INITIAL, { toastOnSuccess: true });
  return (
    <form id={formId} {...formProps} className="flex flex-col items-end gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="dealId" value={dealId} />
      <input type="hidden" name="costId" value={costId} />
      <ConfirmDialog
        trigger={
          <Button type="button" size="sm" variant="ghost" icon={<Trash2 />} aria-label={`Remove ${label}`}>
            Remove
          </Button>
        }
        title={`Remove ${label}?`}
        description="It is no longer counted in this deal's cash or margin. It stays in the deal's record, with who removed it."
        confirmLabel="Remove cost"
        cancelLabel="Keep it"
        formId={formId}
      />
      {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}

/** Link to a bill or milestone: the one it became counts in the plan's place (K2). */
export function LinkCostForm({
  orgSlug,
  dealId,
  costId,
  label,
  candidates,
}: {
  orgSlug: string;
  dealId: string;
  costId: string;
  label: string;
  candidates: Array<{ value: string; name: string; group: "payable" | "milestone" }>;
}) {
  const [target, setTarget] = useState("");
  const { state, formProps } = useActionForm(linkDealCostAction, INITIAL, { toastOnSuccess: true });
  if (candidates.length === 0) return <p className="text-xs text-ink-3">{"No bill or milestone in this deal's currency is free to link yet."}</p>;
  return (
    <form {...formProps} className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="dealId" value={dealId} />
      <input type="hidden" name="costId" value={costId} />
      <input type="hidden" name="target" value={target} />
      <Select value={target} onValueChange={setTarget}>
        <SelectTrigger size="sm" aria-label={`The bill or milestone ${label} became`} className="min-w-0 sm:w-80">
          <SelectValue placeholder="Choose the bill or milestone it became" />
        </SelectTrigger>
        <SelectContent>
          {candidates.map((candidate) => (
            <SelectItem key={candidate.value} value={candidate.value}>
              {candidate.group === "payable" ? "Bill: " : "Milestone: "}
              {candidate.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <SubmitButton size="sm" variant="secondary" icon={<Link2 />} pendingLabel="Linking…" disabled={target === ""}>
        Link
      </SubmitButton>
      {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}
