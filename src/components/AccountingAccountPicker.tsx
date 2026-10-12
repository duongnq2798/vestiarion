"use client";

import { Landmark } from "lucide-react";
import { useState } from "react";
import { chooseAccountingAccountAction, loadAccountingAccountsAction, type AccountingAccountsResult, type AccountingActionResult } from "@/app/actions/accounting";
import { FormMessage } from "@/components/ui/FormMessage";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { accountName, bookingPreview, BOOKS_PAYMENTS, type BookingSample } from "@/lib/connectors/booking";
import type { PaymentAccount } from "@/lib/connectors/connections";
import { PROVIDER_LABELS, type ProviderId } from "@/lib/connectors/provider";

const LOAD_INITIAL: AccountingAccountsResult = { ok: false, message: "" };
const CHOOSE_INITIAL: AccountingActionResult = { ok: false, message: "" };

/**
 * Where payments made on Arc will be booked in an accounting tool (docs/superpowers/specs/2026-10-12-xero-connector-design.md
 * X14, I14; docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q6): an owner or admin reads the accounts a
 * payment can be booked to (Xero's bank accounts and accounts that take payments, QuickBooks' bank accounts; never a
 * revenue or expense account, and none picked for them), previews how a payment would be booked to the one they pick,
 * and uses it. Each payment is booked there only after an owner or admin approves it (accounting write-back W6).
 */
export function AccountingAccountPicker({
  provider,
  orgSlug,
  current,
  sample,
}: {
  provider: ProviderId;
  orgSlug: string;
  current: PaymentAccount | null;
  sample: BookingSample | null;
}) {
  const label = PROVIDER_LABELS[provider];
  const load = useActionForm(loadAccountingAccountsAction, LOAD_INITIAL);
  const choose = useActionForm(chooseAccountingAccountAction, CHOOSE_INITIAL, { toastOnSuccess: true });
  const [picked, setPicked] = useState<string>("");
  const accounts = load.state.accounts ?? [];
  const account = accounts.find((candidate) => candidate.externalId === picked) ?? null;
  const preview = account ? bookingPreview(account, sample, label, BOOKS_PAYMENTS[provider]) : null;

  return (
    <div className="space-y-3">
      <form {...load.formProps} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="provider" value={provider} />
        <SubmitButton variant="secondary" size="sm" pendingLabel={`Reading ${label}…`} icon={<Landmark aria-hidden />}>
          {current ? "Change the account" : "Choose the account"}
        </SubmitButton>
        <FormMessage tone={load.state.message && !load.state.ok ? "error" : "neutral"}>{load.state.ok ? null : load.state.message}</FormMessage>
      </form>
      {accounts.length > 0 && (
        <form {...choose.formProps} className="space-y-3 rounded-lg border border-line p-4">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="provider" value={provider} />
          <RadioGroup
            legend="Book payments made on Arc to"
            name="accountId"
            value={picked}
            onValueChange={setPicked}
            options={accounts.map((candidate) => ({
              value: candidate.externalId,
              label: accountName(candidate),
              description: `${candidate.bank ? "Bank account" : "Takes payments"}${candidate.currency ? ` · ${candidate.currency}` : ""}`,
            }))}
          />
          {preview && (
            <div className="space-y-1 rounded-md bg-surface-2 p-3 text-sm" aria-live="polite">
              <p className="font-medium text-ink">Preview</p>
              {preview.lines.map((line) => (
                <p key={line} className="text-ink-2">
                  {line}
                </p>
              ))}
              {preview.warning && <p className="text-held">{preview.warning}</p>}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton size="sm" pendingLabel="Saving…" disabled={!account}>
              Use this account
            </SubmitButton>
            <FormMessage tone={choose.state.message && !choose.state.ok ? "error" : "neutral"}>{choose.state.ok ? null : choose.state.message}</FormMessage>
          </div>
        </form>
      )}
    </div>
  );
}
