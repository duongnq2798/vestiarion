"use client";

import { Link2, RefreshCw, Unplug } from "lucide-react";
import Link from "next/link";
import { disconnectHubSpotAction, syncHubSpotNowAction, type HubSpotActionResult } from "@/app/actions/hubspot";
import { DocsLink } from "@/components/DocsLink";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { CrmPanelView } from "@/lib/connectors/crm-review";

const INITIAL: HubSpotActionResult = { ok: false, message: "" };

/** What HubSpot's way back from connecting says, by the code it carries in `?hubspot=` (HubSpot connector H4). */
export const HUBSPOT_NOTICES: Record<string, { tone: "success" | "error"; text: string }> = {
  connected: { tone: "success", text: "HubSpot is connected. Its won deals are coming in on Bills & receivables, under Deals." },
  cancelled: { tone: "error", text: "Connecting HubSpot was cancelled. Nothing changed." },
  forbidden: { tone: "error", text: "Only an owner or admin connects HubSpot, from their own browser." },
  other_organisation: { tone: "error", text: "This workspace is connected to another HubSpot account. Disconnect it first, then connect the one you want." },
  other_workspace: {
    tone: "error",
    text: "This HubSpot account is connected to another Vestiarion workspace. Disconnect it there first: one account connects to one workspace.",
  },
  not_set_up: { tone: "error", text: "HubSpot is not set up on this deployment yet." },
  failed: { tone: "error", text: "HubSpot did not finish connecting. Try again in a moment." },
};

function SyncNow({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(syncHubSpotNowAction, INITIAL, { toastOnSuccess: true });
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
  const { state, formProps } = useActionForm(disconnectHubSpotAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Disconnecting…" icon={<Unplug aria-hidden />}>
        Disconnect HubSpot
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

function ConnectButton({ orgSlug, label }: { orgSlug: string; label: string }) {
  return (
    <Button asChild size="sm">
      <Link href={`/integrations/hubspot/connect?org=${orgSlug}`}>
        <Link2 aria-hidden />
        {label}
      </Link>
    </Button>
  );
}

/**
 * The HubSpot section of Settings (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H16, H17, H20): its
 * status in business words, never "connected" while the last sync failed; the won deals to plan and the planned deals
 * changed in HubSpot, each linking to Bills & receivables; a reconnect when HubSpot no longer takes the connection; Sync
 * now and Disconnect HubSpot. Every member sees the status; an owner or admin gets the controls. `view` carries no token.
 */
export default function HubSpotPanel({ orgSlug, view, canManage, notice }: { orgSlug: string; view: CrmPanelView; canManage: boolean; notice: string | null }) {
  const told = notice ? HUBSPOT_NOTICES[notice] : undefined;
  const deals = `/o/${orgSlug}/invoices#from-hubspot`;
  return (
    <section aria-labelledby="hubspot-title" id="hubspot">
      <SectionHeader id="hubspot-title" title="HubSpot" action={<DocsLink href="/docs/guides/hubspot" topic="HubSpot" />} />
      <Card className="space-y-4 p-5">
        {told && (
          <p role="status" className={told.tone === "success" ? "text-sm text-ink" : "text-sm text-refused"}>
            {told.text}
          </p>
        )}
        {view.state === "not_set_up" ? (
          <p className="text-sm text-ink-2">HubSpot is not set up on this deployment yet.</p>
        ) : view.state === "not_connected" ? (
          <div className="max-w-prose space-y-3">
            <p className="text-sm text-ink-2">
              Bring your customers and won deals in from HubSpot. A won deal becomes a deal with its collection schedule when you plan it, from the
              New deal form filled in for you; a deal changed in HubSpot afterwards says so, and nothing changes until you do.
            </p>
            {canManage ? <ConnectButton orgSlug={orgSlug} label="Connect HubSpot" /> : <p className="text-sm text-ink-3">An owner or admin connects HubSpot.</p>}
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
                      {view.changed === 1 ? "1 planned deal changed in HubSpot since." : `${view.changed} planned deals changed in HubSpot since.`}
                    </Link>
                  </li>
                )}
              </ul>
            )}
            {canManage ? (
              <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4">
                {view.status.reconnect && <ConnectButton orgSlug={orgSlug} label="Reconnect HubSpot" />}
                {view.revoked && <ConnectButton orgSlug={orgSlug} label="Connect HubSpot" />}
                {view.connected && <SyncNow orgSlug={orgSlug} />}
                {!view.revoked && <Disconnect orgSlug={orgSlug} />}
              </div>
            ) : (
              <p className="text-sm text-ink-3">An owner or admin manages HubSpot.</p>
            )}
          </>
        )}
      </Card>
    </section>
  );
}
