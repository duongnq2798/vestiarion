"use client";

import { Coins } from "lucide-react";
import { useState } from "react";
import { setReportingCurrencyAction, type CurrencyActionResult } from "@/app/actions/currency";
import { DocsLink } from "@/components/DocsLink";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";
import { utcMinute } from "@/lib/copy";
import { REPORTING_CURRENCIES } from "@/lib/money";

/**
 * The "Reporting currency" section of Settings (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M4):
 * the currency the report and Treasury's plans total in, with the rates shown. Everyone sees it; an owner or admin
 * (`canChange`) sets it. It changes how totals are shown, never what is paid: payments still settle in USDC, or EURC
 * on Arc testnet. `available: false` before migration 0113 runs.
 */
export interface ReportingCurrencyPanelProps {
  orgSlug: string;
  available: boolean;
  setting: { currency: string; setAt: string; setBy: string | null } | null;
  canChange: boolean;
}

const INITIAL: CurrencyActionResult = { ok: false, message: "" };
const save = withSuccessToast(setReportingCurrencyAction);

/** What each currency is, for the picker. */
const NAMES: Record<string, string> = {
  USD: "US dollar",
  EUR: "Euro",
  SGD: "Singapore dollar",
  JPY: "Japanese yen",
  KRW: "South Korean won",
  PHP: "Philippine peso",
  MYR: "Malaysian ringgit",
};

function Choose({ orgSlug, current }: { orgSlug: string; current: string | null }) {
  const form = useActionForm(save, INITIAL);
  const [currency, setCurrency] = useState<string>(current ?? "USD");
  return (
    <form {...form.formProps} className="space-y-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="currency" value={currency} />
      <Field id="reporting-currency" label="Report in" description="Totals in this currency use the day's reference rate, shown beside each one. A rate not recorded shows as unknown.">
        <Select value={currency} onValueChange={setCurrency}>
          <SelectTrigger id="reporting-currency" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REPORTING_CURRENCIES.map((code) => (
              <SelectItem key={code} value={code}>
                {`${code}, ${NAMES[code]}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <SubmitButton icon={<Coins />} pendingLabel="Saving…" disabled={currency === current}>
        Save reporting currency
      </SubmitButton>
      <FormMessage tone={form.state.message && !form.state.ok ? "error" : "neutral"}>{form.state.ok ? null : form.state.message}</FormMessage>
    </form>
  );
}

export default function ReportingCurrencyPanel({ orgSlug, available, setting, canChange }: ReportingCurrencyPanelProps) {
  return (
    <section aria-labelledby="reporting-currency-title">
      <SectionHeader id="reporting-currency-title" title="Reporting currency" action={<DocsLink href="/docs/guides/currencies" topic="currencies and rates" />} />
      <Card className="space-y-4 p-5">
        <div className="space-y-1">
          <p className="text-sm font-medium text-ink">
            {!available
              ? "Not set up on this deployment yet."
              : setting
                ? `${setting.currency}, since ${utcMinute(setting.setAt)}: the report and Treasury's plans total in it, with each rate shown.`
                : "Not set: each amount stays in its own currency, and nothing is added across currencies."}
          </p>
          <p className="text-sm text-ink-2">
            Bills keep the amount and currency written on them. Payments still settle in USDC or EURC, at the amount each bill was converted to.
          </p>
        </div>
        {available && (
          <div className="border-t border-line pt-4">
            {canChange ? <Choose orgSlug={orgSlug} current={setting?.currency ?? null} /> : <p className="text-sm text-ink-2">An owner or admin of this workspace can set it.</p>}
          </div>
        )}
      </Card>
    </section>
  );
}
