"use client";

import { CircleStop, FilePlus2, Save } from "lucide-react";
import { useId, useState } from "react";
import { createCommissionPayableAction, endCommissionPlanAction, setCommissionPlanAction, type CommissionActionResult } from "@/app/actions/commissions";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { BASIS_WORDS, HOLD_DAYS_DEFAULT, REFERENCE_MAX, type CommissionBasis, type CommissionScope, type PlanFormField } from "@/lib/commissions/model";

const INITIAL: CommissionActionResult = { ok: false, message: "" };

/** The plan in force, when the form changes it. */
export interface PlanDefaults {
  planId: string;
  beneficiaryId: string;
  beneficiaryName: string;
  rate: string;
  basis: CommissionBasis;
  scope: CommissionScope;
  dealIds: string[];
  holdDays: number;
  reference: string;
  memberId: string | null;
}

/**
 * A partner's commission plan (docs/superpowers/specs/2026-10-14-commissions-design.md C2): who earns it, the rate, net
 * or gross, the deals it covers, the hold window, a reference, and the member who is this partner when one is. Changing
 * a plan saves its next version; the one in force ends as it starts.
 */
export function CommissionPlanForm({
  orgSlug,
  partners,
  deals,
  members,
  current,
}: {
  orgSlug: string;
  /** Vendors and contractors with no plan in force, for a new plan. */
  partners: Array<{ id: string; name: string }>;
  deals: Array<{ id: string; title: string; customer: string }>;
  /** The workspace's members, to name the one who is this partner; null when they could not be read. */
  members: Array<{ userId: string; email: string }> | null;
  current?: PlanDefaults;
}) {
  const [beneficiary, setBeneficiary] = useState(current?.beneficiaryId ?? "");
  const [scope, setScope] = useState<CommissionScope>(current?.scope ?? "all_deals");
  const [member, setMember] = useState(current?.memberId ?? "none");
  const { state, formProps } = useActionForm(setCommissionPlanAction, INITIAL, {
    toastOnSuccess: true,
    resetOnSuccess: !current,
    onSuccess: () => {
      if (!current) {
        setBeneficiary("");
        setScope("all_deals");
        setMember("none");
      }
    },
  });
  const error = (field: PlanFormField) => (!state.ok && state.field === field ? state.message : undefined);
  const prefix = current ? `plan-${current.planId.slice(0, 8)}` : "plan-new";
  return (
    <form {...formProps} className="space-y-5">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="beneficiaryId" value={beneficiary} />
      <input type="hidden" name="memberId" value={member} />
      {current && <input type="hidden" name="replaces" value={current.planId} />}
      <div className="grid gap-4 sm:grid-cols-3">
        {current ? (
          <div className="grid content-start gap-1.5">
            <p className="text-sm font-medium text-ink">Partner</p>
            <p className="text-sm text-ink-2">{current.beneficiaryName}</p>
          </div>
        ) : (
          <Field id={`${prefix}-partner`} label="Partner" description="A vendor or contractor on file who earns the commission." error={error("beneficiary")}>
            <Select value={beneficiary} onValueChange={setBeneficiary}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a partner" />
              </SelectTrigger>
              <SelectContent>
                {partners.map((partner) => (
                  <SelectItem key={partner.id} value={partner.id}>
                    {partner.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        <Field id={`${prefix}-rate`} label="Rate (%)" error={error("rate")}>
          <Input name="rate" inputMode="decimal" required placeholder="10" defaultValue={current?.rate} />
        </Field>
        <Field
          id={`${prefix}-hold`}
          label="Hold window (days)"
          description="How long after the money is applied a commission waits before it can be paid."
          error={error("holdDays")}
        >
          <Input name="holdDays" inputMode="numeric" placeholder={String(HOLD_DAYS_DEFAULT)} defaultValue={current ? String(current.holdDays) : undefined} />
        </Field>
      </div>
      <RadioGroup
        legend="Commission on"
        name="basis"
        defaultValue={current?.basis ?? "net"}
        options={[
          { value: "net", label: BASIS_WORDS.net, description: "Only money that arrived from the customer." },
          { value: "gross", label: BASIS_WORDS.gross, description: "A few cents lost on the way still earn their commission." },
        ]}
      />
      <div className="space-y-3">
        <RadioGroup
          legend="Deals it covers"
          name="scope"
          value={scope}
          onValueChange={(value) => setScope(value === "chosen_deals" ? "chosen_deals" : "all_deals")}
          options={[
            { value: "all_deals", label: "Every deal" },
            { value: "chosen_deals", label: "Chosen deals" },
          ]}
        />
        {scope === "chosen_deals" &&
          (deals.length === 0 ? (
            <p className="text-sm text-ink-2">This workspace has no deal yet. Add one under Deals on Bills &amp; receivables.</p>
          ) : (
            <fieldset className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-2" aria-describedby={error("deals") ? `${prefix}-deals-error` : undefined}>
              <legend className="sr-only">Chosen deals</legend>
              {deals.map((deal) => (
                <Checkbox key={deal.id} name="dealIds" value={deal.id} defaultChecked={current?.dealIds.includes(deal.id)} label={deal.title} description={deal.customer} />
              ))}
            </fieldset>
          ))}
        {error("deals") && (
          <p id={`${prefix}-deals-error`} className="text-sm text-refused">
            {error("deals")}
          </p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${prefix}-reference`} label="Reference" optional description="The agreement's name or number, named on each payable." error={error("reference")}>
          <Input name="reference" maxLength={REFERENCE_MAX} placeholder="Referral agreement 2026" defaultValue={current?.reference} />
        </Field>
        {members && (
          <Field
            id={`${prefix}-member`}
            label="Member who is this partner"
            optional
            description="That person can never approve this partner's payout, nor change its plan."
            error={error("member")}
          >
            <Select value={member} onValueChange={setMember}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nobody</SelectItem>
                {members.map((each) => (
                  <SelectItem key={each.userId} value={each.userId}>
                    {each.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FormMessage tone="error">{state.ok || state.field ? null : state.message}</FormMessage>
        <SubmitButton icon={<Save />} pendingLabel="Saving…" variant={current ? "secondary" : undefined} className="shrink-0">
          {current ? "Save new version" : "Save plan"}
        </SubmitButton>
      </div>
    </form>
  );
}

/** End a plan: what it earned stays to review; money applied from now on earns nothing under it. Asked first. */
export function EndPlanButton({ orgSlug, planId, partner }: { orgSlug: string; planId: string; partner: string }) {
  const formId = useId();
  const { state, formProps } = useActionForm(endCommissionPlanAction, INITIAL, { toastOnSuccess: true });
  return (
    <form id={formId} {...formProps} className="flex flex-col items-start gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="planId" value={planId} />
      <ConfirmDialog
        trigger={
          <Button type="button" size="sm" variant="ghost" icon={<CircleStop />}>
            End plan
          </Button>
        }
        title={`End the plan of ${partner}?`}
        description="Money applied from now on earns no commission under it. What it earned so far stays, to review and pay."
        confirmLabel="End plan"
        cancelLabel="Keep it"
        formId={formId}
      />
      {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}

/**
 * Create one payable for exactly the commissions shown as due (C10). The ids of the lines shown travel with the form, so
 * a payable never pays a line nobody saw; one that changed meanwhile is refused, and the page shows it as it is now.
 */
export function CreatePayableButton({
  orgSlug,
  beneficiaryId,
  partner,
  currency,
  lineIds,
  amount,
}: {
  orgSlug: string;
  beneficiaryId: string;
  partner: string;
  currency: string;
  lineIds: string[];
  /** The total in words, such as "30.00 USDC". */
  amount: string;
}) {
  const formId = useId();
  const { state, formProps } = useActionForm(createCommissionPayableAction, INITIAL, { toastOnSuccess: true });
  return (
    <form id={formId} {...formProps} className="flex flex-col items-start gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="beneficiaryId" value={beneficiaryId} />
      <input type="hidden" name="currency" value={currency} />
      <input type="hidden" name="lineIds" value={lineIds.join(",")} />
      <ConfirmDialog
        trigger={
          <Button type="button" size="sm" icon={<FilePlus2 />}>
            Create payable
          </Button>
        }
        title={`Create a payable of ${amount} for ${partner}?`}
        description="One payable for every commission due now. The agent decides it like any other bill, under every guardrail, and the partner cannot approve it."
        confirmLabel="Create payable"
        cancelLabel="Not now"
        tone="primary"
        formId={formId}
      />
      {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}
