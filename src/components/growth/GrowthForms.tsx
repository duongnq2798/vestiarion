"use client";

import { Check, Link2, Plus, Save, X } from "lucide-react";
import type { ReactNode } from "react";
import {
  changeLeadStageAction,
  decideLeadAction,
  linkLeadAction,
  logSpendAction,
  recordRevenueAction,
  saveCampaignAction,
  type GrowthResult,
} from "@/app/admin/growth/actions";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { ALL_STAGES, CAMPAIGN_STATUSES, REVENUE_KINDS, REVENUE_WORDS, STAGE_WORDS, words, type Stage } from "@/lib/growth/fields";

/**
 * The founder dashboard's forms (/admin/growth). Each posts to its action in src/app/admin/growth/actions.ts, which asks
 * the team gate again and checks every field; a refusal keeps what was typed. Every one records something for the team
 * and nothing more: none of them sends a message to anyone.
 */

const INITIAL: GrowthResult = { ok: false, message: "" };
const NONE = "none";

export interface CampaignValues {
  id: string;
  name: string;
  strategies: number[];
  segment: string | null;
  offer: string | null;
  starts_on: string | null;
  ends_on: string | null;
  cash_budget_usd: number | null;
  hour_budget: number | null;
  status: string;
}

function Result({ state }: { state: GrowthResult }) {
  return (
    <FormMessage tone={state.ok ? "success" : "error"} className="min-h-0">
      {state.message || null}
    </FormMessage>
  );
}

function Choice({ name, defaultValue, options, label }: { name: string; defaultValue: string; options: ReadonlyArray<{ value: string; label: string }>; label?: string }) {
  return (
    <Select name={name} defaultValue={defaultValue}>
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const grid = "grid gap-3 sm:grid-cols-2";

/** Adds a campaign, or, given `campaign`, changes it (its id stays). */
export function CampaignForm({ campaign, idPrefix = "new" }: { campaign?: CampaignValues; idPrefix?: string }) {
  const { state, formProps } = useActionForm(saveCampaignAction, INITIAL, { resetOnSuccess: !campaign, toastOnSuccess: true });
  const id = (field: string) => `campaign-${idPrefix}-${field}`;
  return (
    <form {...formProps} className="space-y-3">
      <div className={grid}>
        <Field id={id("id")} label="Id" description="2 to 40 of a-z, 0-9 and -. It names the campaign in links and imports.">
          {campaign ? (
            <>
              <Input value={campaign.id} readOnly aria-readonly />
              <input type="hidden" name="id" value={campaign.id} />
            </>
          ) : (
            <Input name="id" required pattern="[a-z0-9\-]{2,40}" placeholder="agency-oct" />
          )}
        </Field>
        <Field id={id("name")} label="Name">
          <Input name="name" required maxLength={120} defaultValue={campaign?.name} placeholder="Software agencies, October" />
        </Field>
        <Field id={id("strategies")} label="GTM strategies" optional description="Numbers from 1 to 50, separated by commas.">
          <Input name="strategies" defaultValue={campaign?.strategies.join(", ")} placeholder="3, 12" />
        </Field>
        <Field id={id("segment")} label="Segment" optional>
          <Input name="segment" maxLength={200} defaultValue={campaign?.segment ?? ""} />
        </Field>
        <Field id={id("offer")} label="Offer" optional className="sm:col-span-2">
          <Input name="offer" maxLength={500} defaultValue={campaign?.offer ?? ""} />
        </Field>
        <Field id={id("starts")} label="Starts" optional>
          <Input name="starts_on" type="date" defaultValue={campaign?.starts_on ?? ""} />
        </Field>
        <Field id={id("ends")} label="Ends" optional>
          <Input name="ends_on" type="date" defaultValue={campaign?.ends_on ?? ""} />
        </Field>
        <Field id={id("cash")} label="Cash budget (USD)" optional>
          <Input name="cash_budget_usd" inputMode="decimal" defaultValue={campaign?.cash_budget_usd ?? ""} />
        </Field>
        <Field id={id("hours")} label="Hour budget" optional>
          <Input name="hour_budget" inputMode="decimal" defaultValue={campaign?.hour_budget ?? ""} />
        </Field>
        <Field id={id("status")} label="Status">
          <Choice name="status" defaultValue={campaign?.status ?? "planned"} options={CAMPAIGN_STATUSES.map((value) => ({ value, label: words(value) }))} />
        </Field>
      </div>
      <Result state={state} />
      <SubmitButton icon={campaign ? <Save /> : <Plus />} pendingLabel="Saving…">
        {campaign ? "Save campaign" : "Add campaign"}
      </SubmitButton>
    </form>
  );
}

export function SpendForm({ campaigns, today }: { campaigns: ReadonlyArray<{ id: string; name: string }>; today: string }) {
  const { state, formProps } = useActionForm(logSpendAction, INITIAL, { resetOnSuccess: true, toastOnSuccess: true });
  return (
    <form {...formProps} className="space-y-3">
      <div className={grid}>
        <Field id="spend-campaign" label="Campaign" optional>
          <Choice name="campaign_id" defaultValue={NONE} options={[{ value: NONE, label: "No campaign" }, ...campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name }))]} />
        </Field>
        <Field id="spend-day" label="Day">
          <Input name="spent_on" type="date" required defaultValue={today} />
        </Field>
        <Field id="spend-usd" label="Cash (USD)" optional>
          <Input name="usd" inputMode="decimal" placeholder="0.00" />
        </Field>
        <Field id="spend-hours" label="Founder hours" optional>
          <Input name="founder_hours" inputMode="decimal" placeholder="0.0" />
        </Field>
        <Field id="spend-note" label="Note" optional className="sm:col-span-2">
          <Input name="note" maxLength={500} />
        </Field>
      </div>
      <Result state={state} />
      <SubmitButton icon={<Plus />} pendingLabel="Logging…">
        Log spend
      </SubmitButton>
    </form>
  );
}

export function RevenueForm({ leads, today }: { leads: ReadonlyArray<{ id: string; name: string }>; today: string }) {
  const { state, formProps } = useActionForm(recordRevenueAction, INITIAL, { resetOnSuccess: true, toastOnSuccess: true });
  return (
    <form {...formProps} className="space-y-3">
      <div className={grid}>
        <Field id="revenue-kind" label="What happened">
          <Choice name="kind" defaultValue="payment_received" options={REVENUE_KINDS.map((value) => ({ value, label: REVENUE_WORDS[value] }))} />
        </Field>
        <Field id="revenue-day" label="Day">
          <Input name="occurred_on" type="date" required defaultValue={today} />
        </Field>
        <Field id="revenue-amount" label="Amount" optional description="Needed for a payment received.">
          <Input name="amount" inputMode="decimal" placeholder="0.00" />
        </Field>
        <Field id="revenue-currency" label="Currency" optional>
          <Input name="currency" maxLength={5} placeholder="USD" />
        </Field>
        <Field id="revenue-lead" label="Lead" optional>
          <Choice name="lead_id" defaultValue={NONE} options={[{ value: NONE, label: "No lead" }, ...leads.map((lead) => ({ value: lead.id, label: lead.name }))]} />
        </Field>
        <Field id="revenue-workspace" label="Workspace" optional description="Its slug.">
          <Input name="workspace" maxLength={80} />
        </Field>
        <Field id="revenue-reference" label="Reference" optional>
          <Input name="reference" maxLength={200} placeholder="Invoice or transfer reference" />
        </Field>
        <Field id="revenue-note" label="Note" optional>
          <Input name="note" maxLength={1000} />
        </Field>
      </div>
      <Result state={state} />
      <SubmitButton icon={<Plus />} pendingLabel="Recording…">
        Record event
      </SubmitButton>
    </form>
  );
}

/** One row of a lead's controls: its fields beside a button, wrapping on a narrow screen. */
function Row({ children }: { children: ReactNode }) {
  return <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">{children}</div>;
}

export function LeadStageForm({ leadId, stage }: { leadId: string; stage: Stage }) {
  const { state, formProps } = useActionForm(changeLeadStageAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="space-y-2">
      <input type="hidden" name="lead_id" value={leadId} />
      <Row>
        <Field id={`stage-${leadId}`} label="Stage">
          <Choice name="stage" defaultValue={stage} options={ALL_STAGES.map((value) => ({ value, label: STAGE_WORDS[value] }))} />
        </Field>
        <Field id={`stage-note-${leadId}`} label="Note" optional>
          <Input name="note" maxLength={1000} />
        </Field>
        <SubmitButton variant="secondary" icon={<Save />} pendingLabel="Saving…">
          Change stage
        </SubmitButton>
      </Row>
      <Result state={state} />
    </form>
  );
}

export function LeadLinkForm({ leadId, workspace }: { leadId: string; workspace: string | null }) {
  const { state, formProps } = useActionForm(linkLeadAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="space-y-2">
      <input type="hidden" name="lead_id" value={leadId} />
      <Row>
        <Field id={`link-${leadId}`} label="Workspace" description="Its slug; empty unlinks.">
          <Input name="workspace" maxLength={80} defaultValue={workspace ?? ""} placeholder="acme-studio" />
        </Field>
        <Field id={`link-note-${leadId}`} label="Note" optional>
          <Input name="note" maxLength={1000} />
        </Field>
        <SubmitButton variant="secondary" icon={<Link2 />} pendingLabel="Saving…">
          Link workspace
        </SubmitButton>
      </Row>
      <Result state={state} />
    </form>
  );
}

/** Approve to contact or reject, with a note (needed to reject). Records a decision only. */
export function LeadDecisionForm({ leadId }: { leadId: string }) {
  const { state, formProps } = useActionForm(decideLeadAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="space-y-2">
      <input type="hidden" name="lead_id" value={leadId} />
      <Field id={`decision-note-${leadId}`} label="Note" optional description="Needed to reject.">
        <Textarea name="note" maxLength={1000} className="min-h-16" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <SubmitButton name="decision" value="approve" icon={<Check />} pendingLabel="Approving…">
          Approve to contact
        </SubmitButton>
        <SubmitButton name="decision" value="reject" variant="danger" icon={<X />} pendingLabel="Rejecting…">
          Reject
        </SubmitButton>
      </div>
      <Result state={state} />
    </form>
  );
}
