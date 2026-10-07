"use client";

import { ShieldOff } from "lucide-react";
import { useState, type FormEvent } from "react";
import { setTwoApprovalsAction } from "@/app/actions/approval-policy";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm, type ActionResult } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";
import { twoApprovalsSentence } from "@/lib/two-approvals";
import { DocsLink } from "@/components/DocsLink";

/**
 * The "Two approvals" section of Settings (docs/superpowers/specs/2026-10-05-two-approvals-design.md T1, T8): the figure
 * above which a payment needs two people's approval, or Off, and how many people can approve payments. Everyone sees
 * it; an owner (`canChange`) sets the figure, or turns it off behind a confirmation that says what that frees. On Arc
 * mainnet a figure always stays (mainnet limits L2), so the panel offers no Turn off there and says so (mainnet copy C11).
 */
export interface TwoApprovalsPanelProps {
  orgSlug: string;
  status: { above: number | null; approvers: number };
  canChange: boolean;
  /** Whether the workspace keeps a figure: one on Arc mainnet does. */
  keepsFigure: boolean;
}

const KEEPS_FIGURE = "A workspace on Arc mainnet keeps two approvals above a figure. Raise it to let one person pay more.";

const INITIAL: ActionResult = { ok: false, message: "" };
const save = withSuccessToast(setTwoApprovalsAction);
const OFF_FORM_ID = "turn-off-two-approvals";

/** How many people can give an approval: owners, admins and approvers. */
function approversLine(count: number): string {
  return `${count} ${count === 1 ? "person can" : "people can"} approve payments here.`;
}

function ChangeForms({ orgSlug, above, keepsFigure }: { orgSlug: string; above: number | null; keepsFigure: boolean }) {
  const setForm = useActionForm(save, INITIAL);
  const offForm = useActionForm(save, INITIAL);
  // Both forms report in one place: whichever was submitted last.
  const [last, setLast] = useState<"set" | "off" | null>(null);
  const shown = last === "set" ? setForm.state : last === "off" ? offForm.state : INITIAL;
  const submitting = (which: "set" | "off", onSubmit: (event: FormEvent<HTMLFormElement>) => void) => (event: FormEvent<HTMLFormElement>) => {
    setLast(which);
    onSubmit(event);
  };

  return (
    <div className="space-y-3">
      <form {...setForm.formProps} onSubmit={submitting("set", setForm.formProps.onSubmit)} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <Field id="two-approvals-above" label="Payments above (USDC)" description="Two people approve any payment to a payee above this.">
          <Input name="above" inputMode="decimal" defaultValue={above ?? ""} placeholder="500" required className="w-40" />
        </Field>
        <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
      </form>
      {above !== null && !keepsFigure && (
        <form id={OFF_FORM_ID} {...offForm.formProps} onSubmit={submitting("off", offForm.formProps.onSubmit)}>
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="above" value="" />
          <ConfirmDialog
            formId={OFF_FORM_ID}
            tone="danger"
            trigger={
              <Button variant="secondary" size="sm" icon={<ShieldOff />} loading={offForm.pending}>
                Turn off
              </Button>
            }
            title="Turn off two approvals?"
            description="One approval will pay any payment again, and the agent will pay on its own within its other limits."
            confirmLabel="Turn off"
          />
        </form>
      )}
      <FormMessage tone={shown.message && !shown.ok ? "error" : "neutral"}>{shown.ok ? null : shown.message}</FormMessage>
    </div>
  );
}

export default function TwoApprovalsPanel({ orgSlug, status, canChange, keepsFigure }: TwoApprovalsPanelProps) {
  return (
    <section aria-labelledby="two-approvals-title">
      <SectionHeader id="two-approvals-title" title="Two approvals" action={<DocsLink href="/docs/guides/first-payment#two-approvals-above-a-figure" topic="two approvals" />} />
      <Card className="space-y-4 p-5">
        <div className="space-y-1">
          <p className="text-sm font-medium text-ink">{status.above === null ? "Off: one approval pays any payment." : twoApprovalsSentence(status.above)}</p>
          <p className="text-sm text-ink-2">
            Above the figure, the agent never pays on its own and no one person pays alone: a first approval is recorded, and a second person&apos;s
            approval pays it. As many of the two as can come from people who neither entered the payment nor gave a new payee&apos;s address must;
            those two give the rest only when no one else can.
          </p>
          {keepsFigure && <p className="text-sm text-ink-2">{KEEPS_FIGURE}</p>}
          <p className="text-xs text-ink-3">{approversLine(status.approvers)}</p>
        </div>
        <div className="border-t border-line pt-4">
          {canChange ? (
            <ChangeForms orgSlug={orgSlug} above={status.above} keepsFigure={keepsFigure} />
          ) : (
            <p className="text-sm text-ink-2">An owner of this workspace can change it.</p>
          )}
        </div>
      </Card>
    </section>
  );
}
