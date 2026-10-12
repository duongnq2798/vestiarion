"use client";

import { Landmark } from "lucide-react";
import { useState } from "react";
import { chooseXeroAccountAction, loadXeroAccountsAction, type XeroAccountsResult, type XeroActionResult } from "@/app/actions/xero";
import { FormMessage } from "@/components/ui/FormMessage";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { accountName, bookingPreview, type BookingSample } from "@/lib/connectors/booking";
import type { PaymentAccount } from "@/lib/connectors/connections";

const LOAD_INITIAL: XeroAccountsResult = { ok: false, message: "" };
const CHOOSE_INITIAL: XeroActionResult = { ok: false, message: "" };

/**
 * Where payments made on Arc will be booked in Xero (docs/superpowers/specs/2026-10-12-xero-connector-design.md X14,
 * I14): an owner or admin reads Xero's chart of accounts, sees the accounts a payment can be booked to (never a revenue
 * or expense account, and none picked for them), previews how a payment would be booked to the one they pick, and uses
 * it. Nothing is written to Xero in this version.
 */
export function XeroAccountPicker({ orgSlug, current, sample }: { orgSlug: string; current: PaymentAccount | null; sample: BookingSample | null }) {
  const load = useActionForm(loadXeroAccountsAction, LOAD_INITIAL);
  const choose = useActionForm(chooseXeroAccountAction, CHOOSE_INITIAL, { toastOnSuccess: true });
  const [picked, setPicked] = useState<string>("");
  const accounts = load.state.accounts ?? [];
  const account = accounts.find((candidate) => candidate.externalId === picked) ?? null;
  const preview = account ? bookingPreview(account, sample, "Xero") : null;

  return (
    <div className="space-y-3">
      <form {...load.formProps} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <SubmitButton variant="secondary" size="sm" pendingLabel="Reading Xero…" icon={<Landmark aria-hidden />}>
          {current ? "Change the account" : "Choose the account"}
        </SubmitButton>
        <FormMessage tone={load.state.message && !load.state.ok ? "error" : "neutral"}>{load.state.ok ? null : load.state.message}</FormMessage>
      </form>
      {accounts.length > 0 && (
        <form {...choose.formProps} className="space-y-3 rounded-lg border border-line p-4">
          <input type="hidden" name="orgSlug" value={orgSlug} />
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
