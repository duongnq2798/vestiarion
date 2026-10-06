"use client";

import { Plus } from "lucide-react";
import { createWorkspaceAction, type CreateWorkspaceResult } from "@/app/onboarding/actions";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: CreateWorkspaceResult = { ok: false, message: "" };

const SANDBOX = "It starts as a sandbox: the money in it is simulated.";

/** The two networks a workspace can be created on, Arc testnet first (mainnet go-live M2). */
const NETWORKS = [
  { value: "arc-testnet", label: "Arc testnet", description: SANDBOX },
  { value: "arc-mainnet", label: "Arc mainnet", description: "Real USDC, from your own Circle account. Nothing moves until an owner takes it live." },
] as const;

/**
 * Success navigates to the new workspace, so the only message shown here is a refusal. With `mainnetOffered` (the
 * person is on the deployment's allowlist while Arc mainnet is on), it asks which network the workspace is on; the
 * action checks that again, whatever the form sends.
 */
export default function CreateWorkspaceForm({ mainnetOffered = false }: { mainnetOffered?: boolean }) {
  const { state, formProps } = useActionForm(createWorkspaceAction, INITIAL);
  return (
    <Card asChild className="space-y-4 p-5 sm:p-6">
      <form {...formProps}>
        <Field id="workspace-name" label="Workspace name" description={mainnetOffered ? undefined : SANDBOX}>
          <Input name="name" type="text" required maxLength={80} autoComplete="organization" />
        </Field>
        {mainnetOffered && <RadioGroup legend="Network" name="network" defaultValue="arc-testnet" options={NETWORKS} />}
        <SubmitButton icon={<Plus />} pendingLabel="Creating…" className="w-full">
          Create workspace
        </SubmitButton>
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
      </form>
    </Card>
  );
}
