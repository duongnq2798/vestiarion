"use client";

import { Link2, RefreshCw, Unplug } from "lucide-react";
import Link from "next/link";
import { disconnectAccountingAction, syncAccountingNowAction, type AccountingActionResult } from "@/app/actions/accounting";
import { AccountingAccountPicker } from "@/components/AccountingAccountPicker";
import { DocsLink } from "@/components/DocsLink";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { BrandName, PROVIDER_MARKS } from "@/components/vx/BrandMarks";
import { withSuccessToast } from "@/components/withSuccessToast";
import { accountName, PICKS_PAYMENT_ACCOUNT } from "@/lib/connectors/booking";
import { billsHref } from "@/lib/bills-view";
import type { AccountingPanelView } from "@/lib/connectors/panel";
import { PROVIDER_LABELS, PROVIDER_WORDS, type AccountingProviderId, type ProviderId } from "@/lib/connectors/provider";

const INITIAL: AccountingActionResult = { ok: false, message: "" };
/**
 * Disconnect's answer is a toast the action raises itself: the revalidated page drops the button in the same render
 * (docs/superpowers/specs/2026-10-27-disconnect-confirmation-design.md DC1).
 */
const disconnect = withSuccessToast(disconnectAccountingAction);

type Notice = { tone: "success" | "error"; text: string };

/**
 * What a tool's way back from connecting says, by the code it carries in `?<provider>=` (Xero connector X4;
 * docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q4, Q5).
 */
export function accountingNotices(provider: ProviderId): Record<string, Notice> {
  const label = PROVIDER_LABELS[provider];
  const { organisation } = PROVIDER_WORDS[provider];
  return {
    connected: { tone: "success", text: `${label} is connected. Its open bills are coming in for review on Bills & receivables.` },
    cancelled: { tone: "error", text: `Connecting ${label} was cancelled. Nothing changed.` },
    forbidden: { tone: "error", text: `Only an owner or admin connects ${label}, from their own browser.` },
    other_organisation: { tone: "error", text: `This workspace is connected to another ${label} ${organisation}. Disconnect it first, then connect the one you want.` },
    other_workspace: {
      tone: "error",
      text: `This ${label} ${organisation} is connected to another Vestiarion workspace. Disconnect it there first, or connect another ${organisation}.`,
    },
    not_set_up: { tone: "error", text: `${label} is not set up on this deployment yet.` },
    failed: { tone: "error", text: `${label} did not finish connecting. Try again in a moment.` },
  };
}

function Hidden({ provider, orgSlug }: { provider: ProviderId; orgSlug: string }) {
  return (
    <>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="provider" value={provider} />
    </>
  );
}

function SyncNow({ provider, orgSlug }: { provider: ProviderId; orgSlug: string }) {
  const { state, formProps } = useActionForm(syncAccountingNowAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <Hidden provider={provider} orgSlug={orgSlug} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Syncing…" icon={<RefreshCw aria-hidden />}>
        Sync now
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

function Disconnect({ provider, orgSlug }: { provider: ProviderId; orgSlug: string }) {
  const { state, formProps } = useActionForm(disconnect, INITIAL);
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <Hidden provider={provider} orgSlug={orgSlug} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Disconnecting…" icon={<Unplug aria-hidden />}>
        Disconnect {PROVIDER_LABELS[provider]}
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

function ConnectButton({ provider, orgSlug, label }: { provider: ProviderId; orgSlug: string; label: string }) {
  return (
    <Button asChild size="sm">
      <Link href={`/integrations/${provider}/connect?org=${orgSlug}`}>
        <Link2 aria-hidden />
        {label}
      </Link>
    </Button>
  );
}

/**
 * An accounting tool's section of Settings (docs/superpowers/specs/2026-10-12-xero-connector-design.md X15, X16, X19;
 * docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q15, Q19), one per tool, headed by its mark
 * (docs/superpowers/specs/2026-10-12-integration-marks-design.md): its status in business
 * words, never "connected" while the last sync failed; the bills waiting for review; a reconnect when the tool no
 * longer takes the connection; Sync now and Disconnect; and, for a tool with accounts, the account payments made on Arc
 * will be booked to. Every member sees the status; an owner or admin gets the controls. `view` carries no token.
 */
export default function AccountingPanel({
  provider,
  orgSlug,
  view,
  canManage,
  notice,
}: {
  provider: AccountingProviderId;
  orgSlug: string;
  view: AccountingPanelView;
  canManage: boolean;
  notice: string | null;
}) {
  const label = PROVIDER_LABELS[provider];
  const words = PROVIDER_WORDS[provider];
  const told = notice ? accountingNotices(provider)[notice] : undefined;
  return (
    <section aria-labelledby={`${provider}-title`} id={provider}>
      <SectionHeader
        id={`${provider}-title`}
        // The mark has no text baseline: the title is a flex row, centred, so Docs sits level with it.
        className="items-center"
        title={<BrandName brand={PROVIDER_MARKS[provider]} name={label} />}
        action={<DocsLink href={`/docs/guides/${provider}`} topic={label} />}
      />
      <Card className="space-y-4 p-5">
        {told && (
          <p role="status" className={told.tone === "success" ? "text-sm text-ink" : "text-sm text-refused"}>
            {told.text}
          </p>
        )}
        {view.state === "not_set_up" ? (
          <p className="text-sm text-ink-2">{label} is not set up on this deployment yet.</p>
        ) : view.state === "not_connected" ? (
          <div className="max-w-prose space-y-3">
            <p className="text-sm text-ink-2">
              Bring your {words.bills} in from {label}. Each one waits for you on Bills & receivables, goes through the same checks as a bill list, and
              becomes a payable only when you add it. The agent then decides it as any other bill.
            </p>
            {canManage ? (
              <ConnectButton provider={provider} orgSlug={orgSlug} label={`Connect ${label}`} />
            ) : (
              <p className="text-sm text-ink-3">An owner or admin connects {label}.</p>
            )}
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <p className={view.status.tone === "error" ? "font-semibold text-refused" : "font-semibold text-ink"}>{view.status.title}</p>
              {view.status.detail.map((line) => (
                <p key={line} className="text-sm text-ink-2">
                  {line}
                </p>
              ))}
            </div>
            {!view.revoked && (
              <ul className="space-y-1 text-sm text-ink-2">
                <li>
                  {view.waiting === 0 ? (
                    "No bills waiting for review."
                  ) : (
                    <Link className="font-medium text-agent underline-offset-4 hover:underline" href={`/o/${orgSlug}${billsHref({ tab: "bills", review: provider === "xero" || provider === "quickbooks" || provider === "zohobooks" ? provider : null })}`}>
                      {view.waiting === 1 ? "1 bill waiting for review" : `${view.waiting} bills waiting for review`}
                    </Link>
                  )}
                </li>
                {view.closedAfterAdded > 0 && (
                  <li className="text-held">
                    {view.closedAfterAdded === 1 ? "1 bill you added was" : `${view.closedAfterAdded} bills you added were`} paid, voided or deleted in {label} since.
                  </li>
                )}
              </ul>
            )}
            {/* A tool with no accounts to choose from (Zoho Books, Z9) says nothing about booking. */}
            {!view.revoked && PICKS_PAYMENT_ACCOUNT[provider] && (
              <div className="space-y-2 border-t border-line pt-4">
                <p className="text-sm font-medium text-ink">Where payments made on Arc will be booked</p>
                <p className="text-sm text-ink-2">
                  {view.paymentAccount
                    ? `${accountName(view.paymentAccount)}${view.paymentAccount.currency ? `, in ${view.paymentAccount.currency}` : ""}.`
                    : "Not chosen yet. Nothing is booked to an account nobody chose."}
                </p>
                {canManage && view.connected && <AccountingAccountPicker provider={provider} orgSlug={orgSlug} current={view.paymentAccount} sample={view.sample} />}
              </div>
            )}
            {/* A connection made before booking was asked for (accounting write-back W8): connecting again grants it. */}
            {view.connected && view.bookingAllowed === false && (
              <div className="space-y-2 border-t border-line pt-4">
                <p className="text-sm font-medium text-ink">Booking payments in {label}</p>
                <p className="max-w-prose text-sm text-ink-2">
                  {label} has not allowed Vestiarion to book payments yet. Connecting again asks {label} for it; the bills, links and the account chosen are kept.
                </p>
                {canManage ? (
                  <ConnectButton provider={provider} orgSlug={orgSlug} label="Allow Vestiarion to book payments" />
                ) : (
                  <p className="text-sm text-ink-3">An owner or admin allows it.</p>
                )}
              </div>
            )}
            {canManage ? (
              <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4">
                {view.status.reconnect && <ConnectButton provider={provider} orgSlug={orgSlug} label={`Reconnect ${label}`} />}
                {view.revoked && <ConnectButton provider={provider} orgSlug={orgSlug} label={`Connect ${label}`} />}
                {view.connected && <SyncNow provider={provider} orgSlug={orgSlug} />}
                {!view.revoked && <Disconnect provider={provider} orgSlug={orgSlug} />}
              </div>
            ) : (
              <p className="text-sm text-ink-3">An owner or admin manages {label}.</p>
            )}
          </>
        )}
      </Card>
    </section>
  );
}
