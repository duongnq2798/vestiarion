"use client";

import { CirclePause, CirclePlay } from "lucide-react";
import { useCallback, useState } from "react";
import { pauseAgentAction, resumeAgentAction } from "@/app/actions/agent";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Textarea } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm, type ActionResult } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";

const INITIAL: ActionResult = { ok: false, message: "" };
const pause = withSuccessToast(pauseAgentAction);
const resume = withSuccessToast(resumeAgentAction);

/**
 * The console's pause switch, beside Run cycle now. While the agent runs,
 * someone with `agent.pause` may stop it, saying why; while it is paused,
 * only someone with `agent.resume` may start it again. It renders nothing
 * for anyone else. The banner on every page, and the refusal of a cycle,
 * come from the pause itself once the page refreshes.
 */
export default function AgentPauseControl({
  orgSlug,
  paused,
  canPause,
  canResume,
}: {
  orgSlug: string;
  paused: boolean;
  canPause: boolean;
  canResume: boolean;
}) {
  if (paused) return canResume ? <ResumeForm orgSlug={orgSlug} /> : null;
  return canPause ? <PauseDialog orgSlug={orgSlug} /> : null;
}

function PauseDialog({ orgSlug }: { orgSlug: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { state, formProps } = useActionForm(pause, INITIAL, { resetOnSuccess: true, onSuccess: close });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" icon={<CirclePause />}>
          Pause agent
        </Button>
      </DialogTrigger>
      <DialogContent title="Pause the agent" description="No cycle runs and no money moves until someone resumes it. Every page says it is paused, and why.">
        <form {...formProps} className="grid gap-5">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <Field id="pause-reason" label="Reason" optional description="At most 280 characters. Shown on every page and kept in the ledger.">
            <Textarea name="reason" maxLength={280} rows={3} />
          </Field>
          <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <SubmitButton variant="danger-solid" pendingLabel="Pausing…">
              Pause
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResumeForm({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(resume, INITIAL);
  return (
    <form {...formProps} className="flex flex-col items-stretch gap-2 sm:items-end">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton icon={<CirclePlay />} pendingLabel="Resuming…">
        Resume agent
      </SubmitButton>
      <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}
