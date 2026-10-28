"use client";

import { setEarnedVendorPaymentsAction, setEarnedVendorRuleAction } from "@/app/actions/earned-vendors";
import { DocsLink } from "@/components/DocsLink";
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
import { EARNED_PAYMENTS_OFF, EARNED_PAYMENTS_ON, EARNED_STREAK_MAX, EARNED_STREAK_MIN, earnedPaymentsConfirm, earnedVendorsSentence } from "@/lib/earned-vendors";

/**
 * The "Earned vendors" section of Settings (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL11): the
 * workspace's rule, N agreed verdicts in a row, after which a vendor counts as earned. Everyone sees it; an owner
 * (`canChange`) sets the number or turns it off. Before the workspace's database has it (`ready`), the panel says so
 * and offers nothing. Earning by itself changes nothing the agent may do (AL20), and the panel says so: Report shows
 * who earned it and why. The page leaves the section out on Arc mainnet, where there are no verdicts.
 *
 * Under a rule, **Pay earned vendors on their own** (AL21): what the owner's switch does now, and for the owner, the
 * switch, turned on behind a confirmation that says what it pays, in test USDC on Arc testnet or simulated, as the
 * co-sign switch is (`TwoApprovalsPanel`).
 */
export interface EarnedVendorsPanelProps {
  orgSlug: string;
  /** `payments` is the switch (AL21); absent reads as off. */
  status: { streak: number | null; ready: boolean; payments?: boolean };
  /** Every payment of the workspace is simulated: the confirmation says so rather than test USDC. */
  simulated?: boolean;
  canChange: boolean;
}

const INITIAL: ActionResult = { ok: false, message: "" };
const save = withSuccessToast(setEarnedVendorRuleAction);
const savePayments = withSuccessToast(setEarnedVendorPaymentsAction);
const PAYMENTS_FORM_ID = "earned-vendor-payments";

/** Pay earned vendors on their own (AL21): what it does now, and the owner's switch. */
function PaymentsSwitch({ orgSlug, on, simulated, canChange }: { orgSlug: string; on: boolean; simulated: boolean; canChange: boolean }) {
  const form = useActionForm(savePayments, INITIAL);
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <p className="text-sm font-medium text-ink">Pay earned vendors on their own</p>
      <p className="text-sm text-ink-2">{on ? EARNED_PAYMENTS_ON : EARNED_PAYMENTS_OFF}</p>
      {canChange && (
        <form id={PAYMENTS_FORM_ID} {...form.formProps} className="space-y-2">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="on" value={on ? "false" : "true"} />
          {on ? (
            <SubmitButton variant="secondary" size="sm" pendingLabel="Turning off…">
              Make them wait for my verdict
            </SubmitButton>
          ) : (
            <ConfirmDialog
              formId={PAYMENTS_FORM_ID}
              tone="primary"
              trigger={
                <Button variant="secondary" size="sm" loading={form.pending}>
                  Let the agent pay earned vendors
                </Button>
              }
              title="Let the agent pay earned vendors on its own?"
              description={earnedPaymentsConfirm(simulated)}
              confirmLabel="Turn on"
            />
          )}
          <FormMessage tone={form.state.message && !form.state.ok ? "error" : "neutral"}>{form.state.ok ? null : form.state.message}</FormMessage>
        </form>
      )}
    </div>
  );
}

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

export default function EarnedVendorsPanel({ orgSlug, status, simulated = false, canChange }: EarnedVendorsPanelProps) {
  return (
    <section aria-labelledby="earned-vendors-title">
      <SectionHeader id="earned-vendors-title" title="Earned vendors" action={<DocsLink href="/docs/guides/shadow-mode#earned-vendors" topic="earned vendors" />} />
      <Card className="space-y-4 p-5">
        <div className="space-y-1">
          <p className="text-sm font-medium text-ink">{status.ready ? earnedVendorsSentence(status.streak) : "Not available in this workspace yet."}</p>
          <p className="text-sm text-ink-2">
            Counted from your verdicts in shadow mode. A vendor needs a payment limit to earn it. Earning changes nothing the agent may do unless an owner lets
            it pay earned vendors on its own. Report shows which vendors earned it, and the verdicts behind each.
          </p>
        </div>
        {status.ready && (
          <div className="border-t border-line pt-4">
            {canChange ? <ChangeForm orgSlug={orgSlug} streak={status.streak} /> : <p className="text-sm text-ink-2">An owner of this workspace can change it.</p>}
          </div>
        )}
        {status.ready && status.streak !== null && <PaymentsSwitch orgSlug={orgSlug} on={status.payments === true} simulated={simulated} canChange={canChange} />}
      </Card>
    </section>
  );
}
