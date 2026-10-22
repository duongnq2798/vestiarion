"use client";

import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { checkScreeningNowAction, type ScreeningCheckState } from "@/app/admin/screening/actions";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { utcMinute } from "@/lib/copy";

/**
 * Check now on the team's /admin/screening (screening health SH1): one press, one lookup of a fixed fictitious company
 * name with the deployment's key, and what came back. Never on page load: each lookup is a metered call. The action asks
 * the team gate again and returns only the origin of the address, never the key.
 */

const INITIAL: ScreeningCheckState = { ok: false, message: "" };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere] text-ink">{children}</dd>
    </div>
  );
}

export function ScreeningCheck({ name }: { name: string }) {
  const { state, formProps } = useActionForm(checkScreeningNowAction, INITIAL);
  const check = state.check;
  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <form {...formProps} className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="secondary" size="sm" pendingLabel="Checking…" icon={<RefreshCw aria-hidden />}>
          Check now
        </SubmitButton>
        <p className="text-xs text-ink-3">Screens &ldquo;{name}&rdquo;, a fictitious company, with this deployment&apos;s provider and key. Nothing is written.</p>
      </form>
      <FormMessage tone={state.message ? (state.ok ? "success" : "error") : "neutral"}>{state.message || null}</FormMessage>
      {check && (
        <dl className="grid gap-2 rounded-xl border border-line bg-surface p-4 text-sm">
          <Row label="Provider">{check.provider ?? "None"}</Row>
          <Row label="Address">{check.origin ?? "None"}</Row>
          <Row label="Key">{check.keySet ? "Set" : "Not set"}</Row>
          <Row label="Variables">{check.variableSet ?? "None set"}</Row>
          <Row label="Result">{check.result}</Row>
          {check.ms !== null && <Row label="Time">{`${check.ms} ms`}</Row>}
          {check.verdict && <Row label="Verdict">{check.verdict}</Row>}
          <Row label="Checked">{utcMinute(check.checkedAt)}</Row>
        </dl>
      )}
    </Card>
  );
}
