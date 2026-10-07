"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { setShadowModeAction } from "@/app/actions/shadow-mode";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm, type ActionResult } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";
import { utcMinute } from "@/lib/copy";
import type { Network } from "@/lib/network";
import { SHADOW_CURRENCIES, type ShadowMode } from "@/lib/shadow-currency";
import { DocsLink } from "@/components/DocsLink";

/**
 * The "Shadow mode" section of Settings (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S1): whether the
 * workspace runs alongside how the business pays today, and in which currency its bills are. Everyone sees it; an owner
 * (`canChange`) turns it on, choosing the currency, or off behind a confirmation that says what stays held. Not offered
 * on Arc mainnet, where the agent pays the real bills.
 */
export interface ShadowModePanelProps {
  orgSlug: string;
  mode: ShadowMode | null;
  network: Network;
  canChange: boolean;
}

const INITIAL: ActionResult = { ok: false, message: "" };
const save = withSuccessToast(setShadowModeAction);
const OFF_FORM_ID = "turn-off-shadow-mode";

function TurnOn({ orgSlug }: { orgSlug: string }) {
  const form = useActionForm(save, INITIAL);
  const [currency, setCurrency] = useState<string>(SHADOW_CURRENCIES[0]);
  return (
    <form {...form.formProps} className="space-y-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="intent" value="start" />
      <input type="hidden" name="currency" value={currency} />
      <Field id="shadow-mode-currency" label="Your currency" description="USDC, or the currency your bills are written in. A bill in another currency is paid in USDC at the day's rate.">
        <Select value={currency} onValueChange={setCurrency}>
          <SelectTrigger id="shadow-mode-currency" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SHADOW_CURRENCIES.map((code) => (
              <SelectItem key={code} value={code}>
                {code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <SubmitButton icon={<Eye />} pendingLabel="Turning on…">
        Turn on shadow mode
      </SubmitButton>
      <FormMessage tone={form.state.message && !form.state.ok ? "error" : "neutral"}>{form.state.ok ? null : form.state.message}</FormMessage>
    </form>
  );
}

function TurnOff({ orgSlug }: { orgSlug: string }) {
  const form = useActionForm(save, INITIAL);
  return (
    <form id={OFF_FORM_ID} {...form.formProps} className="space-y-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="intent" value="end" />
      <ConfirmDialog
        formId={OFF_FORM_ID}
        trigger={
          <Button variant="secondary" size="sm" icon={<EyeOff />} loading={form.pending}>
            Turn off shadow mode
          </Button>
        }
        title="Turn off shadow mode?"
        description="The agent will pay on its own again, within its limits. A payment waiting for a person to agree stays held until a person decides it."
        confirmLabel="Turn off"
      />
      <FormMessage tone={form.state.message && !form.state.ok ? "error" : "neutral"}>{form.state.ok ? null : form.state.message}</FormMessage>
    </form>
  );
}

export default function ShadowModePanel({ orgSlug, mode, network, canChange }: ShadowModePanelProps) {
  const mainnet = network === "arc-mainnet";
  return (
    <section aria-labelledby="shadow-mode-title">
      <SectionHeader id="shadow-mode-title" title="Shadow mode" action={<DocsLink href="/docs/guides/shadow-mode" topic="shadow mode" />} />
      <Card className="space-y-4 p-5">
        <div className="space-y-1">
          <p className="text-sm font-medium text-ink">
            {mode
              ? `On since ${utcMinute(mode.startedAt)}, for bills in ${mode.currency}: the agent pays nothing until a person agrees.`
              : "Off: the agent pays on its own, within its limits."}
          </p>
          <p className="text-sm text-ink-2">
            Keep paying your bills as you do today. The agent decides on the same bills, and you agree or disagree with each decision. Each payment you
            agree to is made in USDC on Arc testnet, at the bill&apos;s amount in USDC.
          </p>
        </div>
        <div className="border-t border-line pt-4">
          {mainnet ? (
            <p className="text-sm text-ink-2">Shadow mode runs on Arc testnet. On Arc mainnet the agent pays your real bills.</p>
          ) : !canChange ? (
            <p className="text-sm text-ink-2">An owner of this workspace can turn it on or off.</p>
          ) : mode ? (
            <TurnOff orgSlug={orgSlug} />
          ) : (
            <TurnOn orgSlug={orgSlug} />
          )}
        </div>
      </Card>
    </section>
  );
}
