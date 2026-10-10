"use client";

import { MailPlus, RefreshCw, Unplug } from "lucide-react";
import { changeInboxAddressAction, turnOffInboxAction, turnOnInboxAction, type InboxActionResult } from "@/app/actions/email-inbox";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { DocsLink } from "@/components/DocsLink";

const INITIAL: InboxActionResult = { ok: false, message: "" };

/** What Settings shows of invoices by email: whether it is on, and the address for an owner or admin alone. */
export type EmailInboxView = { on: false } | { on: true; address: string | null };

function ActionButton({
  orgSlug,
  action,
  label,
  pendingLabel,
  icon,
  primary = false,
}: {
  orgSlug: string;
  action: typeof turnOnInboxAction;
  label: string;
  pendingLabel: string;
  icon: React.ReactNode;
  primary?: boolean;
}) {
  const { state, formProps } = useActionForm(action, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton size="sm" variant={primary ? undefined : "secondary"} pendingLabel={pendingLabel} icon={icon}>
        {label}
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

/**
 * The Invoices by email section of Settings (docs/superpowers/specs/2026-10-03-email-invoices-design.md E2): an owner
 * or admin turns the workspace's address on, takes a new one, or turns it off, and alone sees it. Anyone may send to an
 * address they know, which is why nothing that arrives is added by itself and why a leaked address can be replaced.
 */
export default function EmailInboxPanel({ orgSlug, view, canManage }: { orgSlug: string; view: EmailInboxView; canManage: boolean }) {
  return (
    <section aria-labelledby="email-inbox-settings-title" id="invoices-by-email">
      <SectionHeader id="email-inbox-settings-title" title="Invoices by email" action={<DocsLink href="/docs/guides/email-invoices" topic="invoices by email" />} />
      <Card className="max-w-none space-y-4 p-5">
        <p className="max-w-prose text-sm text-ink-2">
          Forward invoices from your suppliers to this workspace&apos;s address. Vestiarion reads each one the way From a document does,
          and it waits on Bills & receivables for a person to add it: nothing that arrives by email is added, or paid, by itself.
        </p>
        {!view.on ? (
          canManage ? (
            <ActionButton orgSlug={orgSlug} action={turnOnInboxAction} label="Turn on" pendingLabel="Turning on…" icon={<MailPlus aria-hidden />} primary />
          ) : (
            <p className="text-sm text-ink-3">An owner or admin turns on invoices by email.</p>
          )
        ) : view.address ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-sm text-ink">{view.address}</code>
              <CopyButton value={view.address} label="Copy the address" variant="secondary" />
            </div>
            <p className="max-w-prose text-xs leading-5 text-ink-3">
              Anyone who knows the address can send to it. Share it with your suppliers, or forward their emails yourself; if it leaks, take a
              new one and the old one stops at once.
            </p>
            {canManage && (
              <div className="flex flex-wrap items-center gap-3">
                <ActionButton orgSlug={orgSlug} action={changeInboxAddressAction} label="New address" pendingLabel="Changing…" icon={<RefreshCw aria-hidden />} />
                <ActionButton orgSlug={orgSlug} action={turnOffInboxAction} label="Turn off" pendingLabel="Turning off…" icon={<Unplug aria-hidden />} />
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink-3">Invoices by email are on. An owner or admin has the address.</p>
        )}
      </Card>
    </section>
  );
}
