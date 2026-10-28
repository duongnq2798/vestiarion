"use client";

import { setEarnedVendorRuleAction } from "@/app/actions/earned-vendors";
import { DocsLink } from "@/components/DocsLink";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm, type ActionResult } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";
import { EARNED_STREAK_MAX, EARNED_STREAK_MIN, earnedVendorsSentence } from "@/lib/earned-vendors";

/**
 * The "Earned vendors" section of Settings (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL11): the
 * workspace's rule, N agreed verdicts in a row, after which a vendor counts as earned. Everyone sees it; an owner
 * (`canChange`) sets the number or turns it off. Before the workspace's database has it (`ready`), the panel says so
 * and offers nothing. Earning grants nothing (AL20), and the panel says so: Report shows who earned it and why. The
 * page leaves the section out on Arc mainnet, where there are no verdicts.
 */
export interface EarnedVendorsPanelProps {
  orgSlug: string;
  status: { streak: number | null; ready: boolean };
  canChange: boolean;
}

const INITIAL: ActionResult = { ok: false, message: "" };
const save = withSuccessToast(setEarnedVendorRuleAction);

function ChangeForm({ orgSlug, streak }: { orgSlug: string; streak: number | null }) {
  const { state, formProps } = useActionForm(save, INITIAL);
  return (
    <form {...formProps} className="grid gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <div className="flex flex-wrap items-end gap-3">
        <Field id="earned-vendors-streak" label="Agreed verdicts in a row" description={`From ${EARNED_STREAK_MIN} to ${EARNED_STREAK_MAX}.`}>
          <Input name="streak" inputMode="numeric" defaultValue={streak ?? ""} placeholder="8" className="w-24" />
        </Field>
        <SubmitButton name="intent" value="save" pendingLabel="Saving…">
          Save
        </SubmitButton>
        {streak !== null && (
          <SubmitButton name="intent" value="off" variant="secondary" pendingLabel="Turning off…">
            Turn off
          </SubmitButton>
        )}
      </div>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

export default function EarnedVendorsPanel({ orgSlug, status, canChange }: EarnedVendorsPanelProps) {
  return (
    <section aria-labelledby="earned-vendors-title">
      <SectionHeader id="earned-vendors-title" title="Earned vendors" action={<DocsLink href="/docs/guides/shadow-mode#earned-vendors" topic="earned vendors" />} />
      <Card className="space-y-4 p-5">
        <div className="space-y-1">
          <p className="text-sm font-medium text-ink">{status.ready ? earnedVendorsSentence(status.streak) : "Not available in this workspace yet."}</p>
          <p className="text-sm text-ink-2">
            Counted from your verdicts in shadow mode. A vendor needs a payment limit to earn it. Earning changes nothing the agent may do: Report shows which
            vendors earned it, and the verdicts behind each.
          </p>
        </div>
        {status.ready && (
          <div className="border-t border-line pt-4">
            {canChange ? <ChangeForm orgSlug={orgSlug} streak={status.streak} /> : <p className="text-sm text-ink-2">An owner of this workspace can change it.</p>}
          </div>
        )}
      </Card>
    </section>
  );
}
