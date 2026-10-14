"use client";

import { CircleCheck, ExternalLink, Link2, ListChecks, RefreshCw, Unlink } from "lucide-react";
import { useActionState, useId, useState, startTransition } from "react";
import {
  acceptMilestoneWorkAction,
  asanaChoicesAction,
  checkAsanaTaskAction,
  linkAsanaTaskAction,
  setAcceptanceCriteriaAction,
  unlinkAsanaTaskAction,
  type AsanaActionResult,
  type AsanaChoicesResult,
} from "@/app/actions/asana";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { AsanaMilestoneView, AsanaTone, DeliverableView } from "@/lib/asana/views";

/**
 * A milestone's Asana card on Contractors (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A4, A5, A8,
 * A16): link the Asana task its work is delivered in, by pasting the task's link or choosing workspace, project and
 * task; write the acceptance criteria from the agreement; and, once the task is completed, accept the work against the
 * criteria, as the deliverables shown. Every control posts to a server action that reads the person's role again; the
 * view carries words and links only.
 */

const INITIAL: AsanaActionResult = { ok: false, message: "" };
const NO_CHOICES: AsanaChoicesResult = { ok: false, message: "", choices: [] };

const TONES: Record<AsanaTone, "neutral" | "agent" | "proof" | "held"> = { waiting: "neutral", ready: "agent", accepted: "proof", held: "held" };
const KIND_WORDS: Record<DeliverableView["kind"], string> = { attachment: "Attachment", link: "Link in the description", comment_link: "Link in a comment" };

function Message({ state }: { state: AsanaActionResult }) {
  return (
    <FormMessage tone={state.message && !state.ok ? "error" : "neutral"} className="text-xs">
      {state.ok ? null : state.message}
    </FormMessage>
  );
}

function Hidden({ orgSlug, milestoneId }: { orgSlug: string; milestoneId: string }) {
  return (
    <>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="milestoneId" value={milestoneId} />
    </>
  );
}

function CriteriaForm({ orgSlug, milestoneId, criteria }: { orgSlug: string; milestoneId: string; criteria: string | null }) {
  const { state, formProps } = useActionForm(setAcceptanceCriteriaAction, INITIAL, { toastOnSuccess: true });
  const id = useId();
  return (
    <form {...formProps} className="space-y-2">
      <Hidden orgSlug={orgSlug} milestoneId={milestoneId} />
      <label htmlFor={id} className="block text-xs font-semibold text-ink">
        Acceptance criteria, from the agreement
      </label>
      <Textarea id={id} name="criteria" required minLength={3} maxLength={2000} rows={3} defaultValue={criteria ?? ""} placeholder="What the work must be to be accepted: format, scope, count, deadline." />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…" icon={<ListChecks aria-hidden />}>
          {criteria ? "Save the criteria" : "Add the criteria"}
        </SubmitButton>
        <Message state={state} />
      </div>
    </form>
  );
}

/** One level of the picker: a label and a select of what Asana answered. */
function Level({
  id,
  label,
  name,
  value,
  choices,
  loading,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  name?: string;
  value: string;
  choices: AsanaChoicesResult["choices"];
  loading: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="block text-xs text-ink-3">
        {label}
      </label>
      <Select name={name} value={value} onValueChange={onChange} disabled={disabled || loading}>
        <SelectTrigger id={id} size="sm" className="h-11 w-full sm:h-9">
          <SelectValue placeholder={loading ? "Reading Asana…" : "Choose"} />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.gid} value={choice.gid}>
              {choice.completed ? `${choice.name} (completed)` : choice.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Workspace, then project, then task, each read live from Asana with the workspace's connection. */
function Picker({ orgSlug, milestoneId }: { orgSlug: string; milestoneId: string }) {
  const [workspaces, loadWorkspaces, loadingWorkspaces] = useActionState(asanaChoicesAction, NO_CHOICES);
  const [projects, loadProjects, loadingProjects] = useActionState(asanaChoicesAction, NO_CHOICES);
  const [tasks, loadTasks, loadingTasks] = useActionState(asanaChoicesAction, NO_CHOICES);
  const [opened, setOpened] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [project, setProject] = useState("");
  const [task, setTask] = useState("");
  const { state, formProps } = useActionForm(linkAsanaTaskAction, INITIAL, { toastOnSuccess: true });
  const id = useId();
  const ask = (load: (data: FormData) => void, level: string, parent: string) => {
    const data = new FormData();
    data.set("orgSlug", orgSlug);
    data.set("level", level);
    data.set("parent", parent);
    startTransition(() => load(data));
  };
  if (!opened) {
    return (
      <Button
        type="button"
        variant="link"
        className="text-sm"
        onClick={() => {
          setOpened(true);
          ask(loadWorkspaces, "workspaces", "");
        }}
      >
        Choose the task in Asana instead
      </Button>
    );
  }
  return (
    <form {...formProps} className="space-y-2">
      <Hidden orgSlug={orgSlug} milestoneId={milestoneId} />
      <input type="hidden" name="workspaceGid" value={workspace} />
      <input type="hidden" name="projectGid" value={project} />
      <input type="hidden" name="taskGid" value={task} />
      <div className="grid gap-2 sm:grid-cols-3">
        <Level
          id={`${id}-workspace`}
          label="Workspace"
          value={workspace}
          choices={workspaces.choices}
          loading={loadingWorkspaces}
          disabled={false}
          onChange={(value) => {
            setWorkspace(value);
            setProject("");
            setTask("");
            ask(loadProjects, "projects", value);
          }}
        />
        <Level
          id={`${id}-project`}
          label="Project"
          value={project}
          choices={projects.choices}
          loading={loadingProjects}
          disabled={!workspace}
          onChange={(value) => {
            setProject(value);
            setTask("");
            ask(loadTasks, "tasks", value);
          }}
        />
        <Level id={`${id}-task`} label="Task" value={task} choices={tasks.choices} loading={loadingTasks} disabled={!project} onChange={setTask} />
      </div>
      {[workspaces, projects, tasks].map((result, index) =>
        result.message && !result.ok ? (
          <p key={index} role="alert" className="text-xs text-refused">
            {result.message}
          </p>
        ) : null
      )}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" pendingLabel="Linking…" disabled={!task} icon={<Link2 aria-hidden />}>
          Link this task
        </SubmitButton>
        <Message state={state} />
      </div>
    </form>
  );
}

function LinkByUrl({ orgSlug, milestoneId }: { orgSlug: string; milestoneId: string }) {
  const { state, formProps } = useActionForm(linkAsanaTaskAction, INITIAL, { toastOnSuccess: true });
  const id = useId();
  return (
    <form {...formProps} className="space-y-2">
      <Hidden orgSlug={orgSlug} milestoneId={milestoneId} />
      <label htmlFor={id} className="block text-xs font-semibold text-ink">
        The Asana task the work is delivered in
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input id={id} name="taskUrl" type="url" required size="sm" placeholder="https://app.asana.com/0/…" className="h-11 sm:h-8" maxLength={1000} />
        <SubmitButton variant="secondary" size="sm" pendingLabel="Linking…" className="h-11 shrink-0 sm:h-8" icon={<Link2 aria-hidden />}>
          Link the task
        </SubmitButton>
      </div>
      <p className="text-xs text-ink-3">Vestiarion reads the task through Asana with this workspace&apos;s connection, never by opening the link.</p>
      <Message state={state} />
    </form>
  );
}

function Deliverables({ items }: { items: DeliverableView[] }) {
  if (items.length === 0) return <p className="text-sm text-ink-3">No attachment, and no link in the description or the comments.</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((item) => (
        <li key={`${item.kind}-${item.label}-${item.href ?? ""}`} className="min-w-0 text-sm">
          <span className="text-xs text-ink-3">{KIND_WORDS[item.kind]}: </span>
          {item.href ? (
            <a href={item.href} target="_blank" rel="noreferrer nofollow ugc" className="break-words font-medium text-agent underline-offset-4 hover:underline">
              {item.label}
              <ExternalLink aria-hidden className="ml-1 inline size-3" />
              <span className="sr-only"> (opens in a new tab{item.given ? ", not checked by Vestiarion" : ""})</span>
            </a>
          ) : (
            <span className="break-words text-ink-2">{item.label}</span>
          )}
          {item.note && <span className="block text-xs text-held">{item.note}</span>}
        </li>
      ))}
    </ul>
  );
}

function Accept({ orgSlug, milestoneId, fingerprint, criteriaSha256 }: { orgSlug: string; milestoneId: string; fingerprint: string; criteriaSha256: string }) {
  const { state, formProps } = useActionForm(acceptMilestoneWorkAction, INITIAL, { toastOnSuccess: true });
  const id = useId();
  return (
    <form {...formProps} className="space-y-2 rounded-lg border border-agent-line bg-agent-soft p-3">
      <Hidden orgSlug={orgSlug} milestoneId={milestoneId} />
      <input type="hidden" name="fingerprint" value={fingerprint} />
      <input type="hidden" name="criteriaSha256" value={criteriaSha256} />
      <Checkbox id={id} name="confirmed" value="yes" required label="I checked each criterion against these deliverables, as shown here." />
      <p className="text-xs text-ink-2">Accepting verifies the milestone. The agent then decides on pay under every guardrail; nothing from Asana sets the amount or the payee.</p>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" pendingLabel="Accepting…" icon={<CircleCheck aria-hidden />}>
          Accept the work
        </SubmitButton>
        <Message state={state} />
      </div>
    </form>
  );
}

function SmallAction({
  orgSlug,
  milestoneId,
  action,
  label,
  pending,
  icon,
}: {
  orgSlug: string;
  milestoneId: string;
  action: (previous: AsanaActionResult, data: FormData) => Promise<AsanaActionResult>;
  label: string;
  pending: string;
  icon: React.ReactNode;
}) {
  const { state, formProps } = useActionForm(action, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-2">
      <Hidden orgSlug={orgSlug} milestoneId={milestoneId} />
      <SubmitButton variant="secondary" size="sm" pendingLabel={pending} icon={icon}>
        {label}
      </SubmitButton>
      <Message state={state} />
    </form>
  );
}

export function AsanaTaskCard({ orgSlug, milestoneId, view }: { orgSlug: string; milestoneId: string; view: AsanaMilestoneView }) {
  if (!view.linked) {
    if (!view.canWrite) return null;
    return (
      <div className="mt-2 space-y-3 rounded-xl border border-line bg-ground/40 p-3" data-asana-state="unlinked">
        <p className="text-sm font-semibold text-ink">Accept from Asana</p>
        {view.connected ? (
          <>
            <p className="text-sm text-ink-2">
              Link the task the contractor delivers in. Once it is completed in Asana, you accept the work against its criteria; a completed task alone never
              pays.
            </p>
            <LinkByUrl orgSlug={orgSlug} milestoneId={milestoneId} />
            <Picker orgSlug={orgSlug} milestoneId={milestoneId} />
            <CriteriaForm orgSlug={orgSlug} milestoneId={milestoneId} criteria={view.criteria} />
          </>
        ) : (
          <p className="text-sm text-ink-3">Connect Asana in Settings, Integrations, to accept this work from an Asana task.</p>
        )}
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-3 rounded-xl border border-line bg-ground/40 p-3" data-asana-state={view.state}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm font-semibold text-ink">
          <span className="text-ink-3">Asana task: </span>
          {view.taskUrl ? (
            <a href={view.taskUrl} target="_blank" rel="noreferrer" className="break-words text-agent underline-offset-4 hover:underline">
              {view.taskName}
              <span className="sr-only"> (opens Asana in a new tab)</span>
            </a>
          ) : (
            <span className="break-words">{view.taskName}</span>
          )}
        </p>
        <Badge size="sm" tone={TONES[view.tone]} dot>
          {view.label}
        </Badge>
      </div>
      <p className="text-sm text-ink-2">{view.line}</p>
      <ul className="space-y-0.5 text-xs text-ink-3">
        {view.facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      {view.readError && (
        <p role="status" className="text-xs text-held">
          {view.readError}
        </p>
      )}
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-ink">{view.state === "accepted" ? "Deliverables accepted" : "Deliverables in Asana"}</p>
        <Deliverables items={view.deliverables} />
      </div>
      <div className="space-y-1.5">
        {view.canWrite && view.canEditCriteria ? (
          <CriteriaForm orgSlug={orgSlug} milestoneId={milestoneId} criteria={view.criteria} />
        ) : (
          <>
            <p className="text-xs font-semibold text-ink">Acceptance criteria</p>
            <p className="whitespace-pre-line text-sm text-ink-2">{view.criteria ?? "None written yet."}</p>
          </>
        )}
      </div>
      {view.canWrite && view.canAccept && view.fingerprint && view.criteriaSha256 && (
        <Accept orgSlug={orgSlug} milestoneId={milestoneId} fingerprint={view.fingerprint} criteriaSha256={view.criteriaSha256} />
      )}
      {view.canWrite && (
        <div className="flex flex-wrap items-start gap-3 border-t border-line pt-3">
          <SmallAction orgSlug={orgSlug} milestoneId={milestoneId} action={checkAsanaTaskAction} label="Check Asana now" pending="Reading…" icon={<RefreshCw aria-hidden />} />
          <SmallAction orgSlug={orgSlug} milestoneId={milestoneId} action={unlinkAsanaTaskAction} label="Unlink the task" pending="Unlinking…" icon={<Unlink aria-hidden />} />
        </div>
      )}
    </div>
  );
}
