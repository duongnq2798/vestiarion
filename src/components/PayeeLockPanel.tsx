"use client";

import { FileJson } from "lucide-react";
import { setPayeeLockAction } from "@/app/actions/payee-lock";
import { DocsLink } from "@/components/DocsLink";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormMessage } from "@/components/ui/FormMessage";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm, type ActionResult } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";
import { COOLING_HOURS_CHOICES, type PayeeLock } from "@/lib/payee-lock-rules";

/**
 * The "Payee lock" section of Settings (docs/superpowers/specs/2026-10-20-payee-lock-design.md PL1): whether a changed
 * payout address needs a recorded check by another person before anyone pays it, and how long it waits after it
 * changes. Everyone sees it; an owner (`canChange`) changes it. Before the workspace's database has it (`ready`), the
 * panel says so and offers nothing. Once it has, any member can download the evidence pack: every address change and how
 * it was checked (docs/superpowers/specs/2026-10-21-payee-lock-evidence-design.md EP1).
 */
export interface PayeeLockPanelProps {
  orgSlug: string;
  status: { lock: PayeeLock; ready: boolean };
  canChange: boolean;
}

const INITIAL: ActionResult = { ok: false, message: "" };
const save = withSuccessToast(setPayeeLockAction);

/** A wait, in words. */
export function coolingWords(hours: number): string {
  if (hours <= 0) return "No wait";
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** What the lock does now, in one sentence. */
export function payeeLockSentence(lock: PayeeLock): string {
  if (!lock.on) return "Off: anyone who may approve payments confirms a changed address, and approving a payment to it confirms it too.";
  return lock.coolingHours > 0
    ? `On: a changed address needs a recorded check by another person, and waits ${coolingWords(lock.coolingHours).toLowerCase()} before it is paid.`
    : "On: a changed address needs a recorded check by another person before it is paid.";
}

function ChangeForm({ orgSlug, lock }: { orgSlug: string; lock: PayeeLock }) {
  const { state, formProps } = useActionForm(save, INITIAL);
  return (
    <form {...formProps} className="grid gap-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <Checkbox
        name="on"
        defaultChecked={lock.on}
        label="Turn on the payee lock"
        description="Confirm address then asks how the address was checked, the person who entered or asked for it cannot confirm it while someone else can, and approving a payment no longer confirms its address."
      />
      <RadioGroup
        name="coolingHours"
        legend="Wait after an address changes"
        defaultValue={String(lock.coolingHours)}
        options={COOLING_HOURS_CHOICES.map((hours) => ({
          value: String(hours),
          label: coolingWords(hours),
          ...(hours === 24 ? { description: "Time for the real payee to notice a change they did not make." } : {}),
        }))}
      />
      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
      </div>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

export default function PayeeLockPanel({ orgSlug, status, canChange }: PayeeLockPanelProps) {
  return (
    <section aria-labelledby="payee-lock-title">
      <SectionHeader id="payee-lock-title" title="Payee lock" action={<DocsLink href="/docs/guides/first-payment#payee-lock" topic="the payee lock" />} />
      <Card className="space-y-4 p-5">
        <div className="space-y-1">
          <p className="text-sm font-medium text-ink">{status.ready ? payeeLockSentence(status.lock) : "Not available in this workspace yet."}</p>
          <p className="text-sm text-ink-2">
            The costliest payment fraud is a payee&apos;s address quietly changed. Every payment to a changed address already waits for a person to
            confirm it. The lock makes that confirmation a recorded check, by someone other than whoever entered the address, and can make the
            address wait before it is paid.
          </p>
        </div>
        {status.ready && (
          <div className="border-t border-line pt-4">
            {canChange ? <ChangeForm orgSlug={orgSlug} lock={status.lock} /> : <p className="text-sm text-ink-2">An owner of this workspace can change it.</p>}
          </div>
        )}
        {status.ready && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <p className="text-sm text-ink-2">Every address change, who entered it, how it was checked and by whom, and its first payment, signed.</p>
            <Button asChild size="sm" variant="secondary">
              <a href={`/api/evidence/payee-lock?org=${encodeURIComponent(orgSlug)}`} download>
                <FileJson aria-hidden />
                Download the evidence pack
              </a>
            </Button>
          </div>
        )}
      </Card>
    </section>
  );
}
