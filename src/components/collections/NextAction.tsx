"use client";

import { ArrowRight, Mail, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId } from "react";
import { resolveCollectionTaskAction, setCollectionPolicyAction, type CollectionActionResult } from "@/app/actions/collections";
import { Badge } from "@/components/ui/Badge";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { ACTION_TONES, ALL_TONES, TONE_LABELS, type ProposalView, type ReminderPreview, type RulesView, type TaskView } from "@/lib/collection-context/view";

const INITIAL: CollectionActionResult = { ok: false, message: "" };

/**
 * A receivable's next step, from its customer's context (docs/superpowers/specs/2026-10-13-collections-context-design.md
 * C8), in its card on the Receivables tab: the proposal and the facts it rests on, the reminder it would send exactly as
 * the customer would read it, the task it waits on (with the ways to resolve it), and the customer's rules. An owner or
 * admin resolves the task and saves the rules; every other member reads.
 */
export function NextAction({
  orgSlug,
  view,
  canWrite,
  rulesAvailable,
  open = [],
}: {
  orgSlug: string;
  view: ProposalView;
  canWrite: boolean;
  rulesAvailable: boolean;
  /** What starts open: the pictures show the preview and the rules. */
  open?: ReadonlyArray<"preview" | "rules">;
}) {
  return (
    <section aria-label="Next step" className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={ACTION_TONES[view.action]} dot>
          {view.actionLabel}
        </Badge>
        <p className="min-w-0 text-sm font-semibold text-ink">{view.headline}</p>
      </div>
      <div>
        <p className="text-xs font-medium text-ink-3">Why</p>
        <ul className="mt-1 grid gap-1">
          {view.reasons.map((reason) => (
            <li key={reason} className="flex items-start gap-1.5 text-[0.8125rem] leading-5 text-ink-2">
              <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-ink-3" />
              <span className="min-w-0 break-words">{reason}</span>
            </li>
          ))}
        </ul>
      </div>
      {view.crm && (
        <p className="text-xs text-ink-3">
          Sold through HubSpot: {view.crm.name}
          {view.crm.hasOwner ? ", which has an owner there" : ""}.{" "}
          {view.crm.url && (
            <a href={view.crm.url} target="_blank" rel="noreferrer" className="font-medium text-agent underline-offset-4 hover:underline">
              Open the deal in HubSpot
            </a>
          )}
        </p>
      )}
      {view.sends && <p className="text-xs leading-5 text-ink-3">{view.sends}</p>}
      {view.preview && <Preview preview={view.preview} defaultOpen={open.includes("preview")} />}
      {view.task && <TaskCard orgSlug={orgSlug} task={view.task} canWrite={canWrite} />}
      {view.resolved && <p className="text-xs text-ink-3">Last: {view.resolved}</p>}
      <Disclosure
        summary={`Rules for ${view.rules.customerName}${view.rules.version > 0 ? ` · version ${view.rules.version}` : ""}`}
        defaultOpen={open.includes("rules")}
        contentClassName="grid gap-3"
      >
        <p className="text-[0.8125rem] leading-5 text-ink-2">{view.rules.words}</p>
        {canWrite && rulesAvailable ? (
          <RulesForm orgSlug={orgSlug} rules={view.rules} channelTo={view.preview?.to ?? null} />
        ) : (
          <p className="text-xs text-ink-3">{rulesAvailable ? "An owner or admin sets a customer's rules." : "Customer rules are not set up on this deployment yet."}</p>
        )}
      </Disclosure>
    </section>
  );
}

function Preview({ preview, defaultOpen }: { preview: ReminderPreview; defaultOpen: boolean }) {
  return (
    <Disclosure
      defaultOpen={defaultOpen}
      summary={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2">
          <Mail aria-hidden className="size-4 text-ink-3" />
          <span>Preview the reminder</span>
          <span className="text-xs font-normal text-ink-3">
            {preview.channel} to {preview.to} · {TONE_LABELS[preview.tone]}
          </span>
        </span>
      }
      contentClassName="grid gap-2"
    >
      <dl className="grid gap-1 text-[0.8125rem]">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-ink-3">Channel</dt>
          <dd className="text-ink">
            {preview.channel} to {preview.to}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-ink-3">Subject</dt>
          <dd className="min-w-0 break-words font-medium text-ink">{preview.subject}</dd>
        </div>
      </dl>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-ground px-3 py-2.5 font-sans text-[0.8125rem] leading-5 text-ink-2">
        {preview.text}
      </pre>
      <p className="text-xs text-ink-3">The customer gets exactly this template. Nothing the agent or a customer wrote is added to it.</p>
    </Disclosure>
  );
}

function TaskCard({ orgSlug, task, canWrite }: { orgSlug: string; task: TaskView; canWrite: boolean }) {
  const router = useRouter();
  const id = useId();
  const resolve = useActionForm(resolveCollectionTaskAction, INITIAL, { toastOnSuccess: true, onSuccess: () => router.refresh() });
  const approves = task.outcomes.some((outcome) => outcome.value === "approved");
  const holds = task.outcomes.some((outcome) => outcome.value === "held");
  return (
    <div className="grid gap-3 rounded-xl border border-held-line bg-held-soft/40 px-3 py-3">
      <p className="flex items-start gap-1.5 text-sm font-semibold text-ink">
        <ArrowRight aria-hidden className="mt-0.5 size-4 shrink-0 text-held" />
        <span>
          {task.label}
          <span className="block text-xs font-normal text-ink-3">
            {task.askedOf} · {task.opened}
          </span>
        </span>
      </p>
      {canWrite ? (
        <form {...resolve.formProps} className="grid gap-3">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="taskId" value={task.id} />
          {approves && task.tones.length > 0 && (
            <RadioGroup
              legend="Tone, if you send it"
              name="tone"
              defaultValue={task.tone ?? task.tones[0]}
              options={task.tones.map((tone) => ({ value: tone, label: TONE_LABELS[tone] }))}
            />
          )}
          {holds && (
            <Field id={`${id}-hold`} label="Hold until" description="For a hold: the last day reminders wait, up to 60 days ahead.">
              <Input type="date" name="holdUntil" min={task.holdFrom} max={task.holdTo} className="max-w-48" />
            </Field>
          )}
          <div className="flex flex-wrap gap-2">
            {task.outcomes.map((outcome, index) => (
              <SubmitButton key={outcome.value} size="sm" variant={index === 0 ? "primary" : "secondary"} name="outcome" value={outcome.value} pendingLabel="Saving…">
                {outcome.label}
              </SubmitButton>
            ))}
          </div>
          {!resolve.state.ok && resolve.state.message && <FormMessage tone="error">{resolve.state.message}</FormMessage>}
        </form>
      ) : (
        <p className="text-xs text-ink-3">An owner or admin answers it.</p>
      )}
    </div>
  );
}

const MAX_TONE_LABELS: Record<string, string> = { friendly: "Friendly only", firm: "Up to firm", final: "Any tone, the final reminder included" };

function RulesForm({ orgSlug, rules, channelTo }: { orgSlug: string; rules: RulesView; channelTo: string | null }) {
  const router = useRouter();
  const id = useId();
  const save = useActionForm(setCollectionPolicyAction, INITIAL, { toastOnSuccess: true, onSuccess: () => router.refresh() });
  return (
    <form {...save.formProps} className="grid gap-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="counterpartyId" value={rules.counterpartyId} />
      <input type="hidden" name="expectedVersion" value={rules.version} />
      <RadioGroup
        legend="Reminders"
        name="approval"
        defaultValue={rules.approval}
        options={[
          { value: "auto", label: "Go on their own", description: "Within the schedule and these bounds, as the agent decides." },
          { value: "ask_first", label: "Ask first", description: "Every reminder waits for the account owner's OK, for a customer such as a VIP." },
        ]}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${id}-tone`} label="Strongest tone">
          <Select name="maxTone" defaultValue={rules.maxTone}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALL_TONES.map((tone) => (
                <SelectItem key={tone} value={tone}>
                  {MAX_TONE_LABELS[tone]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id={`${id}-days`} label="Days between reminders" description={`At least 3, at most ${rules.maxDaysBetween}.`}>
          <Input type="number" name="minDaysBetween" min={3} max={rules.maxDaysBetween} step={1} defaultValue={rules.minDaysBetween} inputMode="numeric" className="max-w-28" />
        </Field>
        <Field id={`${id}-owner`} label="Account owner" description="Who is asked first. Owners and admins only.">
          <Select name="accountOwner" defaultValue={rules.accountOwner ?? "owners"}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="owners">The owners and admins</SelectItem>
              {rules.owners.map((owner) => (
                <SelectItem key={owner.id} value={owner.id}>
                  {owner.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="grid content-start gap-1.5">
          <p className="text-sm font-medium text-ink">Channel</p>
          <p className="text-sm text-ink-2">Email{channelTo ? ` to ${channelTo}` : ", to the customer's billing email"}</p>
        </div>
      </div>
      <p className="text-xs leading-5 text-ink-3">
        Saving confirms the tone and channel for {rules.customerName}, as version {rules.version + 1}. The agent follows the latest version from its next cycle;
        an approval given under an earlier one no longer counts.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton size="sm" variant="secondary" icon={<Save />} pendingLabel="Saving…">
          Save rules
        </SubmitButton>
        {!save.state.ok && save.state.message && <FormMessage tone="error">{save.state.message}</FormMessage>}
      </div>
    </form>
  );
}
