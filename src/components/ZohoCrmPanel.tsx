"use client";

import { Link2, RefreshCw, Unplug } from "lucide-react";
import Link from "next/link";
import { disconnectZohoCrmAction, syncZohoCrmNowAction, type ZohoCrmActionResult } from "@/app/actions/zohocrm";
import { DocsLink } from "@/components/DocsLink";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { BrandName, PROVIDER_MARKS } from "@/components/vx/BrandMarks";
import { withSuccessToast } from "@/components/withSuccessToast";
import type { CrmPanelView } from "@/lib/connectors/crm-review";
import { billsHref } from "@/lib/bills-view";

const INITIAL: ZohoCrmActionResult = { ok: false, message: "" };
/**
 * Disconnect's answer is a toast the action raises itself: the revalidated page drops the button in the same render
 * (docs/superpowers/specs/2026-10-27-disconnect-confirmation-design.md DC1).
 */
const disconnect = withSuccessToast(disconnectZohoCrmAction);

/** What Zoho CRM's way back from connecting says, by the code it carries in `?zohocrm=` (Zoho CRM connector C4). */
export const ZOHO_CRM_NOTICES: Record<string, { tone: "success" | "error"; text: string }> = {
  connected: { tone: "success", text: "Zoho CRM is connected. Its won deals are coming in on Bills & receivables, under Deals." },
  cancelled: { tone: "error", text: "Connecting Zoho CRM was cancelled. Nothing changed." },
  forbidden: { tone: "error", text: "Only an owner or admin connects Zoho CRM, from their own browser." },
  other_organisation: { tone: "error", text: "This workspace is connected to another Zoho CRM organization. Disconnect it first, then connect the one you want." },
  not_set_up: { tone: "error", text: "Zoho CRM is not set up on this deployment yet." },
  failed: { tone: "error", text: "Zoho CRM did not finish connecting. Try again in a moment." },
};

/** The note under a connected card: what the connection sees, in plain words (C12). */
export const ZOHO_CRM_VISIBILITY_NOTE = "Vestiarion sees the deals the Zoho CRM user who connected can see, and writes nothing to Zoho CRM.";

function SyncNow({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(syncZohoCrmNowAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Syncing…" icon={<RefreshCw aria-hidden />}>
        Sync now
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

function Disconnect({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(disconnect, INITIAL);
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Disconnecting…" icon={<Unplug aria-hidden />}>
        Disconnect Zoho CRM
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

function ConnectButton({ orgSlug, label }: { orgSlug: string; label: string }) {
  return (
    <Button asChild size="sm">
      <Link href={`/integrations/zohocrm/connect?org=${orgSlug}`}>
        <Link2 aria-hidden />
        {label}
      </Link>
    </Button>
  );
}

/**
 * The Zoho CRM section of Settings (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C16, C17), headed by
 * its mark and its name: its status in business words, never "connected" while the last sync failed; the won deals to
 * plan and the planned deals changed in Zoho CRM, each linking to Bills & receivables; what the connection sees; a
 * reconnect when Zoho no longer takes the connection; Sync now and Disconnect Zoho CRM. Nothing about writing: Zoho CRM
 * is read only. Every member sees the status; an owner or admin gets the controls. `view` carries no token.
 */
export default function ZohoCrmPanel({ orgSlug, view, canManage, notice }: { orgSlug: string; view: CrmPanelView; canManage: boolean; notice: string | null }) {
  const told = notice ? ZOHO_CRM_NOTICES[notice] : undefined;
  const deals = `/o/${orgSlug}${billsHref({ tab: "receivables" })}#from-zohocrm`;
  return (
    <section aria-labelledby="zohocrm-title" id="zohocrm">
      <SectionHeader
        id="zohocrm-title"
        // The mark has no text baseline: the title is a flex row, centred, so Docs sits level with it.
        className="items-center"
        title={<BrandName brand={PROVIDER_MARKS.zohocrm} name="Zoho CRM" />}
        action={<DocsLink href="/docs/guides/zohocrm" topic="Zoho CRM" />}
      />
      <Card className="space-y-4 p-5">
        {told && (
          <p role="status" className={told.tone === "success" ? "text-sm text-ink" : "text-sm text-refused"}>
            {told.text}
          </p>
        )}
        {view.state === "not_set_up" ? (
          <p className="text-sm text-ink-2">Zoho CRM is not set up on this deployment yet.</p>
        ) : view.state === "not_connected" ? (
          <div className="max-w-prose space-y-3">
            <p className="text-sm text-ink-2">
              Bring your won deals in from Zoho CRM, with their accounts and contacts. A won deal becomes a deal with its collection schedule when you plan
              it, from the New deal form filled in for you; a deal changed in Zoho CRM afterwards says so, and nothing changes until you do.
            </p>
            {canManage ? <ConnectButton orgSlug={orgSlug} label="Connect Zoho CRM" /> : <p className="text-sm text-ink-3">An owner or admin connects Zoho CRM.</p>}
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
                  {view.toPlan === 0 ? (
                    "No won deals waiting to be planned."
                  ) : (
                    <Link className="font-medium text-agent underline-offset-4 hover:underline" href={deals}>
                      {view.toPlan === 1 ? "1 won deal to plan" : `${view.toPlan} won deals to plan`}
                    </Link>
                  )}
                </li>
                {view.changed > 0 && (
                  <li className="text-held">
                    <Link className="underline-offset-4 hover:underline" href={deals}>
                      {view.changed === 1 ? "1 planned deal changed in Zoho CRM since." : `${view.changed} planned deals changed in Zoho CRM since.`}
                    </Link>
                  </li>
                )}
                <li className="text-ink-3">{ZOHO_CRM_VISIBILITY_NOTE}</li>
              </ul>
            )}
            {canManage ? (
              <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4">
                {view.status.reconnect && <ConnectButton orgSlug={orgSlug} label="Reconnect Zoho CRM" />}
                {view.revoked && <ConnectButton orgSlug={orgSlug} label="Connect Zoho CRM" />}
                {view.connected && <SyncNow orgSlug={orgSlug} />}
                {!view.revoked && <Disconnect orgSlug={orgSlug} />}
              </div>
            ) : (
              <p className="text-sm text-ink-3">An owner or admin manages Zoho CRM.</p>
            )}
          </>
        )}
      </Card>
    </section>
  );
}
