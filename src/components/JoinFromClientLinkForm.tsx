"use client";

import { Plus } from "lucide-react";
import { joinFromClientLinkAction, type JoinFromClientLinkResult } from "@/app/join/actions";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: JoinFromClientLinkResult = { ok: false, message: "" };

/** What the workspace is, said before it is made (accountant client links AC3): always Arc testnet, in shadow mode. */
export const JOIN_WORKSPACE_LINE =
  "It opens on Arc testnet in shadow mode: you keep paying your bills as you do today, and the agent decides on the same bills and pays nothing until you agree.";

/** The consent the client gives by ticking the box (AC2): who comes in, as what, and how to undo it. */
export function joinConsentLine(accountantEmail: string): string {
  return `Let ${accountantEmail} into this workspace as its accountant. I can remove them from Members at any time.`;
}

/**
 * The client's form on an accountant's link (AC2, AC3): a workspace name and the explicit consent. Success navigates to
 * the new workspace, so the only message shown here is a refusal.
 */
export default function JoinFromClientLinkForm({ token, accountantEmail }: { token: string; accountantEmail: string }) {
  const { state, formProps } = useActionForm(joinFromClientLinkAction, INITIAL);
  return (
    <Card asChild className="space-y-5 p-5 sm:p-6">
      <form {...formProps}>
        <input type="hidden" name="token" value={token} />
        <Field id="join-workspace-name" label="Workspace name" description={JOIN_WORKSPACE_LINE}>
          <Input name="name" type="text" required maxLength={80} autoComplete="organization" placeholder="Acme Studio" />
        </Field>
        <Checkbox name="consent" required label={joinConsentLine(accountantEmail)} />
        <div className="space-y-2">
          <FormMessage tone="error" className="min-h-0">
            {state.ok ? null : state.message}
          </FormMessage>
          <SubmitButton icon={<Plus />} pendingLabel="Opening…" className="w-full">
            Open my workspace
          </SubmitButton>
        </div>
      </form>
    </Card>
  );
}
