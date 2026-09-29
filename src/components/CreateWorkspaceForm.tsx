"use client";

import { Plus } from "lucide-react";
import { createWorkspaceAction, type CreateWorkspaceResult } from "@/app/onboarding/actions";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: CreateWorkspaceResult = { ok: false, message: "" };

/** Success navigates to the new workspace, so the only message shown here is a refusal. */
export default function CreateWorkspaceForm() {
  const { state, formProps } = useActionForm(createWorkspaceAction, INITIAL);
  return (
    <Card asChild className="space-y-4 p-5 sm:p-6">
      <form {...formProps}>
        <Field id="workspace-name" label="Workspace name" description="It starts as a sandbox: the money in it is simulated.">
          <Input name="name" type="text" required maxLength={80} autoComplete="organization" />
        </Field>
        <SubmitButton icon={<Plus />} pendingLabel="Creating…" className="w-full">
          Create workspace
        </SubmitButton>
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
      </form>
    </Card>
  );
}
