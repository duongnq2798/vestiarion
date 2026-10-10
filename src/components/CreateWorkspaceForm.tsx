"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { createWorkspaceAction, type CreateWorkspaceResult } from "@/app/onboarding/actions";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: CreateWorkspaceResult = { ok: false, message: "" };

const SANDBOX = "It starts as a sandbox: the money in it is simulated.";

/** True of every workspace on creation, whichever network: a sandbox simulates, and Arc mainnet waits for go-live. */
const NO_MONEY_MOVES = "Creating a workspace moves no money.";

/**
 * Shadow mode from the start (shadow mode S1), on Arc testnet only: the action turns it on as Settings does, in USDC.
 * Settings offers the business's own currency.
 */
export const SHADOW_LABEL = "Run alongside how you pay today (shadow mode)";
export const SHADOW_DESCRIPTION = "The agent decides on your real bills and pays nothing until you agree. Bills in USDC; for your own currency, turn it on in Settings instead.";

/**
 * The two kinds of workspace, by what they are for and then the network they run on, the test one first and
 * recommended (mainnet go-live M2; workspaces page design W4). The production one says what it is without naming the
 * setup it needs: that comes when an owner takes it live.
 */
const NETWORKS = [
  {
    value: "arc-testnet",
    label: (
      <span className="inline-flex flex-wrap items-center gap-2">
        Test workspace
        <Badge tone="agent" size="sm">
          Recommended
        </Badge>
      </span>
    ),
    description: `Arc testnet. ${SANDBOX} Try everything before going live.`,
  },
  {
    value: "arc-mainnet",
    label: (
      <span className="inline-flex flex-wrap items-center gap-2">
        Production workspace
        <Badge tone="held" size="sm">
          Real funds
        </Badge>
      </span>
    ),
    description: "Arc mainnet. Real USDC: nothing moves until an owner finishes setup and takes it live.",
  },
] as const;

/**
 * Success navigates to the new workspace, so the only message shown here is a refusal. With `mainnetOffered` (the
 * person is on the deployment's allowlist while Arc mainnet is on), it asks which kind of workspace, so which network;
 * the action checks that again, whatever the form sends. Shadow mode is offered for an Arc testnet workspace, ticked
 * when `shadowChosen` (the person came from the landing page's "Try it on your bills").
 */
export default function CreateWorkspaceForm({ mainnetOffered = false, shadowChosen = false }: { mainnetOffered?: boolean; shadowChosen?: boolean }) {
  const { state, formProps } = useActionForm(createWorkspaceAction, INITIAL);
  const [network, setNetwork] = useState("arc-testnet");
  return (
    <Card asChild className="space-y-5 p-5 sm:p-6">
      <form {...formProps}>
        <Field id="workspace-name" label="Workspace name" description={mainnetOffered ? undefined : SANDBOX}>
          <Input name="name" type="text" required maxLength={80} autoComplete="organization" placeholder="Acme Studio" />
        </Field>
        {mainnetOffered && <RadioGroup legend="Network" name="network" defaultValue="arc-testnet" onValueChange={setNetwork} options={NETWORKS} />}
        {network === "arc-testnet" && <Checkbox name="shadow" defaultChecked={shadowChosen} label={SHADOW_LABEL} description={SHADOW_DESCRIPTION} />}
        <div className="space-y-2">
          {/* Empty until a refusal, so it takes no room; the live region is still in the page for a screen reader. */}
          <FormMessage tone="error" className="min-h-0">
            {state.ok ? null : state.message}
          </FormMessage>
          <SubmitButton icon={<Plus />} pendingLabel="Creating…" className="w-full">
            Create workspace
          </SubmitButton>
          <p className="text-center text-xs text-ink-3">{NO_MONEY_MOVES}</p>
        </div>
      </form>
    </Card>
  );
}
