"use client";

import { Link2, PenLine, PenOff, RefreshCw, Unplug } from "lucide-react";
import Link from "next/link";
import { disconnectPipedriveAction, setPipedriveReceiptsAction, syncPipedriveNowAction, type PipedriveActionResult } from "@/app/actions/pipedrive";
import { DocsLink } from "@/components/DocsLink";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { CrmPanelView } from "@/lib/connectors/crm-review";
import type { CrmReceiptsPanel } from "@/lib/connectors/crm-receipts-view";
import { billsHref } from "@/lib/bills-view";

const INITIAL: PipedriveActionResult = { ok: false, message: "" };

/** What Pipedrive's way back from connecting says, by the code it carries in `?pipedrive=` (Pipedrive connector P4). */
export const PIPEDRIVE_NOTICES: Record<string, { tone: "success" | "error"; text: string }> = {
  connected: { tone: "success", text: "Pipedrive is connected. Its won deals are coming in on Bills & receivables, under Deals." },
  cancelled: { tone: "error", text: "Connecting Pipedrive was cancelled. Nothing changed." },
  forbidden: { tone: "error", text: "Only an owner or admin connects Pipedrive, from their own browser." },
  other_organisation: { tone: "error", text: "This workspace is connected to another Pipedrive company. Disconnect it first, then connect the one you want." },
  other_workspace: {
    tone: "error",
    text: "This Pipedrive company is connected to another Vestiarion workspace. Disconnect it there first: one company connects to one workspace.",
  },
  not_set_up: { tone: "error", text: "Pipedrive is not set up on this deployment yet." },
  failed: { tone: "error", text: "Pipedrive did not finish connecting. Try again in a moment." },
  scopes: {
    tone: "error",
    text: "Pipedrive installed Vestiarion without the permissions it reads deals and organizations with, so nothing was kept and the app was removed again. The deployment's Pipedrive app needs its scopes set in Pipedrive's Developer Hub.",
  },
};

/** The note under a connected card: what the connection sees, in plain words (P13). */
export const VISIBILITY_NOTE = "Vestiarion sees the deals the Pipedrive user who connected can see. Connect as a Pipedrive admin to bring every deal in.";

function SyncNow({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(syncPipedriveNowAction, INITIAL, { toastOnSuccess: true });
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
  const { state, formProps } = useActionForm(disconnectPipedriveAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Disconnecting…" icon={<Unplug aria-hidden />}>
        Disconnect Pipedrive
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

function ConnectButton({ orgSlug, label }: { orgSlug: string; label: string }) {
  return (
    <Button asChild size="sm">
      <Link href={`/integrations/pipedrive/connect?org=${orgSlug}`}>
        <Link2 aria-hidden />
        {label}
      </Link>
    </Button>
  );
}

function ReceiptsSwitch({ orgSlug, on }: { orgSlug: string; on: boolean }) {
  const { state, formProps } = useActionForm(setPipedriveReceiptsAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="on" value={on ? "no" : "yes"} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…" icon={on ? <PenOff aria-hidden /> : <PenLine aria-hidden />}>
        {on ? "Stop writing to Pipedrive" : "Write receipts to Pipedrive"}
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Receipts in Pipedrive (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P11, P12): whether Vestiarion
 * writes what each planned deal collected to Pipedrive, how the writes stand, and the reality rule. Pipedrive grants
 * every scope at once, so there is nothing to allow; a workspace on Arc testnet or in shadow mode never writes, and is
 * offered no switch, only the reason.
 */
function Receipts({ orgSlug, receipts, canManage }: { orgSlug: string; receipts: CrmReceiptsPanel; canManage: boolean }) {
  const { counts } = receipts;
  const standing = [
    counts.written > 0 ? count(counts.written, "deal written", "deals written") : null,
    counts.waiting > 0 ? `${counts.waiting} waiting` : null,
    counts.failed > 0 ? `${counts.failed} not written yet, tried again on their own` : null,
    counts.conflicts > 0 ? `${counts.conflicts} changed in Pipedrive, waiting on you` : null,
    counts.refused > 0 ? `${counts.refused} not written` : null,
  ].filter((line): line is string => line !== null);
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <h3 className="text-sm font-semibold text-ink">Receipts in Pipedrive</h3>
      <p className="max-w-prose text-sm text-ink-2">
        {receipts.blocked && !receipts.on
          ? "From a workspace on Arc mainnet outside shadow mode, Vestiarion can write each deal's collections back to Pipedrive: what was collected from payments confirmed on Arc, what is still owed, the last receipt, the reconciliation status and a link to the deal in Vestiarion."
          : receipts.on
          ? "On: each deal planned from Pipedrive gets what it collected, what is still owed, the last receipt, the reconciliation status and a link to it in Vestiarion, in Vestiarion's own deal fields. Only payments confirmed on Arc and applied to an invoice count."
          : "Write each deal's collections back to Pipedrive, so sales sees whether the customer paid: what was collected from payments confirmed on Arc, what is still owed, the last receipt, the reconciliation status and a link to the deal in Vestiarion. Vestiarion never changes Pipedrive's own fields, and never writes over a field someone changed there."}
      </p>
      {receipts.on && standing.length > 0 && <p className="text-sm text-ink-2">{standing.join(" · ")}.</p>}
      {receipts.on && !receipts.allowed && <p className="text-sm text-held">Pipedrive has not granted Vestiarion its write permissions: nothing is written until it does.</p>}
      {receipts.rule && <p className="max-w-prose text-sm text-ink-3">{receipts.rule}</p>}
      {canManage ? (
        (receipts.on || (receipts.allowed && !receipts.blocked)) && (
          <div className="flex flex-wrap items-start gap-3 pt-1">
            <ReceiptsSwitch orgSlug={orgSlug} on={receipts.on} />
          </div>
        )
      ) : (
        <p className="text-sm text-ink-3">An owner or admin turns writing to Pipedrive on or off.</p>
      )}
    </div>
  );
}

/**
 * The Pipedrive section of Settings (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P16, P17, P20),
 * headed by Pipedrive's name alone: its status in business words, never "connected" while the last sync failed; the won
 * deals to plan and the planned deals changed in Pipedrive, each linking to Bills & receivables; what the connection
 * sees; a reconnect when Pipedrive no longer takes the connection; Sync now and Disconnect Pipedrive. Every member sees
 * the status; an owner or admin gets the controls. `view` carries no token.
 */
export default function PipedrivePanel({
  orgSlug,
  view,
  canManage,
  notice,
  receipts = null,
}: {
  orgSlug: string;
  view: CrmPanelView;
  canManage: boolean;
  notice: string | null;
  /** Receipts written to Pipedrive; null before migration 0116, or once disconnected. */
  receipts?: CrmReceiptsPanel | null;
}) {
  const told = notice ? PIPEDRIVE_NOTICES[notice] : undefined;
  const deals = `/o/${orgSlug}${billsHref({ tab: "receivables" })}#from-pipedrive`;
  return (
    <section aria-labelledby="pipedrive-title" id="pipedrive">
      <SectionHeader id="pipedrive-title" className="items-center" title="Pipedrive" action={<DocsLink href="/docs/guides/pipedrive" topic="Pipedrive" />} />
      <Card className="space-y-4 p-5">
        {told && (
          <p role="status" className={told.tone === "success" ? "text-sm text-ink" : "text-sm text-refused"}>
            {told.text}
          </p>
        )}
        {view.state === "not_set_up" ? (
          <p className="text-sm text-ink-2">Pipedrive is not set up on this deployment yet.</p>
        ) : view.state === "not_connected" ? (
          <div className="max-w-prose space-y-3">
            <p className="text-sm text-ink-2">
              Bring your won deals in from Pipedrive, with their organizations and persons. A won deal becomes a deal with its collection schedule when you
              plan it, from the New deal form filled in for you; a deal changed in Pipedrive afterwards says so, and nothing changes until you do.
            </p>
            {canManage ? <ConnectButton orgSlug={orgSlug} label="Connect Pipedrive" /> : <p className="text-sm text-ink-3">An owner or admin connects Pipedrive.</p>}
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
                      {view.changed === 1 ? "1 planned deal changed in Pipedrive since." : `${view.changed} planned deals changed in Pipedrive since.`}
                    </Link>
                  </li>
                )}
                <li className="text-ink-3">{VISIBILITY_NOTE}</li>
              </ul>
            )}
            {receipts && !view.revoked && <Receipts orgSlug={orgSlug} receipts={receipts} canManage={canManage} />}
            {canManage ? (
              <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4">
                {view.status.reconnect && <ConnectButton orgSlug={orgSlug} label="Reconnect Pipedrive" />}
                {view.revoked && <ConnectButton orgSlug={orgSlug} label="Connect Pipedrive" />}
                {view.connected && <SyncNow orgSlug={orgSlug} />}
                {!view.revoked && <Disconnect orgSlug={orgSlug} />}
              </div>
            ) : (
              <p className="text-sm text-ink-3">An owner or admin manages Pipedrive.</p>
            )}
          </>
        )}
      </Card>
    </section>
  );
}
