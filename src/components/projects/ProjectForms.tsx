"use client";

import { Archive, FolderInput, FolderMinus, Plus, RotateCcw, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { assignToProjectAction, changeProjectAction, createProjectAction, setProjectStatusAction, type ProjectActionResult } from "@/app/actions/projects";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { ProjectFormField } from "@/lib/projects/model";

const INITIAL: ProjectActionResult = { ok: false, message: "" };

/** The project's own fields: a name, a budget in USDC and a buffer kept back from it. */
function ProjectFields({ error, defaults }: { error: (field: ProjectFormField) => string | undefined; defaults?: { name: string; budget: string; buffer: string } }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Field id="project-name" label="Name" error={error("name")}>
        <Input name="name" maxLength={80} required placeholder="Website rebuild for Acme" defaultValue={defaults?.name} />
      </Field>
      <Field id="project-budget" label="Budget (USDC)" error={error("budget")}>
        <Input name="budget" inputMode="decimal" required placeholder="12,000.00" defaultValue={defaults?.budget} />
      </Field>
      <Field
        id="project-buffer"
        label="Buffer (USDC)"
        optional
        description="Part of the budget the agent keeps back: a bill that would reach into it waits for a person."
        error={error("buffer")}
      >
        <Input name="buffer" inputMode="decimal" placeholder="500.00" defaultValue={defaults?.buffer} />
      </Field>
    </div>
  );
}

/** New project: a key made when the page was drawn travels with the form, so sending it twice makes one project. */
export function NewProjectForm({ orgSlug, idempotencyKey }: { orgSlug: string; idempotencyKey: string }) {
  const router = useRouter();
  const { state, formProps } = useActionForm(createProjectAction, INITIAL, {
    toastOnSuccess: true,
    resetOnSuccess: true,
    onSuccess: (result) => {
      if (result.projectId) router.push(`/o/${orgSlug}/projects/${result.projectId}`);
    },
  });
  const error = (field: ProjectFormField) => (!state.ok && state.field === field ? state.message : undefined);
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <ProjectFields error={error} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FormMessage tone="error">{state.ok || state.field ? null : state.message}</FormMessage>
        <SubmitButton icon={<Plus />} pendingLabel="Making…" className="shrink-0">
          Make project
        </SubmitButton>
      </div>
    </form>
  );
}

/** Change a project's name, budget or buffer. What is already set aside stays set aside. */
export function ChangeProjectForm({ orgSlug, projectId, defaults }: { orgSlug: string; projectId: string; defaults: { name: string; budget: string; buffer: string } }) {
  const { state, formProps } = useActionForm(changeProjectAction, INITIAL, { toastOnSuccess: true });
  const error = (field: ProjectFormField) => (!state.ok && state.field === field ? state.message : undefined);
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="projectId" value={projectId} />
      <ProjectFields error={error} defaults={defaults} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FormMessage tone="error">{state.ok || state.field ? null : state.message}</FormMessage>
        <SubmitButton icon={<Save />} pendingLabel="Saving…" variant="secondary" className="shrink-0">
          Save project
        </SubmitButton>
      </div>
    </form>
  );
}

/** Archive a project once nothing open is left in it, or reopen one. */
export function ProjectStatusButton({ orgSlug, projectId, archived }: { orgSlug: string; projectId: string; archived: boolean }) {
  const { state, formProps } = useActionForm(setProjectStatusAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-col items-start gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="status" value={archived ? "active" : "archived"} />
      <SubmitButton size="sm" variant="secondary" icon={archived ? <RotateCcw /> : <Archive />} pendingLabel="Saving…">
        {archived ? "Reopen project" : "Archive project"}
      </SubmitButton>
      {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}

/** Put an open bill, milestone or deal in this project: its money is set aside at once when the budget holds it. */
export function AddToProjectForm({
  orgSlug,
  projectId,
  candidates,
}: {
  orgSlug: string;
  projectId: string;
  candidates: Array<{ kind: "bill" | "milestone" | "deal"; id: string; label: string }>;
}) {
  const [subject, setSubject] = useState("");
  const { state, formProps } = useActionForm(assignToProjectAction, INITIAL, { toastOnSuccess: true, onSuccess: () => setSubject("") });
  const groups = [
    { kind: "bill", label: "Bills" },
    { kind: "milestone", label: "Milestones" },
    { kind: "deal", label: "Deals" },
  ] as const;
  if (candidates.length === 0) return <p className="text-sm text-ink-2">Every open bill, milestone and deal is in a project already, or there is none.</p>;
  return (
    <form {...formProps} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="subject" value={subject} />
      <Field id="project-add" label="Put in this project" className="min-w-0 flex-1">
        <Select value={subject} onValueChange={setSubject}>
          <SelectTrigger>
            <SelectValue placeholder="Choose a bill, a milestone or a deal" />
          </SelectTrigger>
          <SelectContent>
            {groups.map((group) =>
              candidates
                .filter((candidate) => candidate.kind === group.kind)
                .map((candidate) => (
                  <SelectItem key={`${candidate.kind}:${candidate.id}`} value={`${candidate.kind}:${candidate.id}`}>
                    {group.label.slice(0, -1)}: {candidate.label}
                  </SelectItem>
                ))
            )}
          </SelectContent>
        </Select>
      </Field>
      <SubmitButton icon={<FolderInput />} pendingLabel="Adding…" disabled={subject === ""} className="shrink-0">
        Add to project
      </SubmitButton>
      {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}

/** Take a bill, milestone or deal out of its project: what was set aside for it is released. */
export function RemoveFromProjectButton({ orgSlug, kind, id, label }: { orgSlug: string; kind: "bill" | "milestone" | "deal"; id: string; label: string }) {
  const { state, formProps } = useActionForm(assignToProjectAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-col items-end gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="subject" value={`${kind}:${id}`} />
      <input type="hidden" name="projectId" value="" />
      <SubmitButton size="sm" variant="ghost" icon={<FolderMinus />} pendingLabel="Taking out…" aria-label={`Take ${label} out of this project`}>
        Take out
      </SubmitButton>
      {!state.ok && state.message && <FormMessage tone="error">{state.message}</FormMessage>}
    </form>
  );
}
