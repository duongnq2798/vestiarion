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
        {mainnetOffered && (
          <fieldset className="grid gap-3">
            <legend className="mb-1 text-sm font-medium text-ink">Network</legend>
            {NETWORKS.map((network) => (
              <label key={network.value} className="flex cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="network"
                  value={network.value}
                  defaultChecked={network.value === "arc-testnet"}
                  className="mt-1 size-4 shrink-0 cursor-pointer accent-agent"
                />
                <span className="grid gap-0.5">
                  <span className="text-sm leading-6 text-ink">{network.label}</span>
                  <span className="text-xs text-ink-3">{network.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <SubmitButton icon={<Plus />} pendingLabel="Creating…" className="w-full">
          Create workspace
        </SubmitButton>
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
      </form>
    </Card>
  );
}
