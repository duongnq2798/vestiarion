"use client";

import { Plus } from "lucide-react";
import { createMilestoneAction, type MilestoneActionResult } from "@/app/actions/milestones";
import type { IntakeCounterparty } from "@/components/intake/InvoiceIntake";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: MilestoneActionResult = { ok: false, message: "" };

/** One milestone, typed in. It waits as pending until its work is verified; the agent pays verified ones. */
export default function MilestoneIntake({ contractors, orgSlug }: { contractors: IntakeCounterparty[]; orgSlug: string }) {
  const { state, formProps } = useActionForm(createMilestoneAction, INITIAL, { resetOnSuccess: true, toastOnSuccess: true });
  const none = contractors.length === 0;

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="milestone-contractor" label="Contractor" description={none ? "Add a contractor or vendor in Counterparties first — every milestone pays one." : undefined}>
          <Select name="contractorId" required disabled={none}>
            <SelectTrigger>
              <SelectValue placeholder="Select a contractor" />
            </SelectTrigger>
            <SelectContent>
              {contractors.map((contractor) => (
                <SelectItem key={contractor.id} value={contractor.id}>
                  {contractor.name} · {contractor.role}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="milestone-amount" label="Amount (USDC)">
          <Input name="amount" required inputMode="decimal" placeholder="900.00" />
        </Field>
        <Field id="milestone-title" label="Work delivered" className="sm:col-span-2">
          <Input name="title" required minLength={3} maxLength={160} placeholder="Homepage redesign, first round" />
        </Field>
        <Field
          id="milestone-evidence"
          label="Evidence link"
          optional
          description="A GitHub pull request is checked for you. Any other link is kept for whoever verifies the work."
          className="sm:col-span-2"
        >
          <Input name="evidence" type="url" maxLength={500} placeholder="https://github.com/your-org/your-repo/pull/42" />
        </Field>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
        <SubmitButton icon={<Plus />} disabled={none} pendingLabel="Adding…" className="shrink-0">
          Add milestone
        </SubmitButton>
      </div>
      <p className="text-xs text-ink-3">The agent pays a milestone once it is verified: by its pull request being merged, or by someone here choosing Verify manually.</p>
    </form>
  );
}
