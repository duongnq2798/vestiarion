"use client";

import { Link2 } from "lucide-react";
import { connectSlackAccountAction, type SlackActionResult } from "@/app/actions/slack";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: SlackActionResult = { ok: false, message: "" };

/** Connect on /integrations/slack/connect (Slack design S4): posts the code and the workspace; the session says who. */
export function SlackConnectForm({ orgSlug, code }: { orgSlug: string; code: string }) {
  const { state, formProps } = useActionForm(connectSlackAccountAction, INITIAL);
  if (state.ok) {
    return (
      <p role="status" className="text-sm text-ink">
        {state.message}
      </p>
    );
  }
  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="code" value={code} />
      <SubmitButton pendingLabel="Connecting…" icon={<Link2 aria-hidden />}>
        Connect my Slack account
      </SubmitButton>
      <FormMessage tone={state.message ? "error" : "neutral"}>{state.message || null}</FormMessage>
    </form>
  );
}
