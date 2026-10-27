"use client";

import { Link2, PenLine, PenOff, RefreshCw, Unplug } from "lucide-react";
import Link from "next/link";
import { disconnectHubSpotAction, setHubSpotReceiptsAction, syncHubSpotNowAction, type HubSpotActionResult } from "@/app/actions/hubspot";
import { DocsLink } from "@/components/DocsLink";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { BrandMark } from "@/components/vx/BrandMarks";
import { withSuccessToast } from "@/components/withSuccessToast";
import type { CrmPanelView } from "@/lib/connectors/crm-review";
import type { CrmReceiptsPanel } from "@/lib/connectors/crm-receipts-view";
import { billsHref } from "@/lib/bills-view";
import { HUBSPOT_WRITE_STEPS } from "@/lib/hubspot/write-steps";

const INITIAL: HubSpotActionResult = { ok: false, message: "" };
/**
 * Disconnect's answer is a toast the action raises itself: the revalidated page drops the button in the same render
 * (docs/superpowers/specs/2026-10-27-disconnect-confirmation-design.md DC1).
 */
const disconnect = withSuccessToast(disconnectHubSpotAction);

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
  // Writing receipts allowed on the connect page (CRM receipts R3).
  writing: { tone: "success", text: "HubSpot is connected, and Vestiarion writes receipts to the deals planned from it, from the next sync." },
  write_not_granted: {
    tone: "error",
    text: `HubSpot connected without allowing Vestiarion to write. It still reads your deals. To allow writing, choose Allow writing to HubSpot again. ${HUBSPOT_WRITE_STEPS.tick} ${HUBSPOT_WRITE_STEPS.locked}`,
  },
  write_not_set_up: { tone: "error", text: "HubSpot is connected. Writing receipts is not set up on this deployment yet." },
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
  const { state, formProps } = useActionForm(disconnect, INITIAL);
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

function ConnectButton({ orgSlug, label, write = false, variant }: { orgSlug: string; label: string; write?: boolean; variant?: "secondary" }) {
  return (
    <Button asChild size="sm" variant={variant}>
      <Link href={`/integrations/hubspot/connect?org=${orgSlug}${write ? "&write=1" : ""}`}>
        {write && variant ? <PenLine aria-hidden /> : <Link2 aria-hidden />}
        {label}
      </Link>
    </Button>
  );
}

function ReceiptsSwitch({ orgSlug, on }: { orgSlug: string; on: boolean }) {
  const { state, formProps } = useActionForm(setHubSpotReceiptsAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="on" value={on ? "no" : "yes"} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…" icon={on ? <PenOff aria-hidden /> : <PenLine aria-hidden />}>
        {on ? "Stop writing to HubSpot" : "Write receipts to HubSpot"}
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Receipts in HubSpot (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R3, R8): whether Vestiarion writes what
 * each planned deal collected to HubSpot, how the writes stand, what HubSpot says the account is and the reality rule;
 * Write receipts to HubSpot or Stop writing to HubSpot, and Allow writing to HubSpot when HubSpot has not granted it.
 */
function Receipts({ orgSlug, receipts, canManage }: { orgSlug: string; receipts: CrmReceiptsPanel; canManage: boolean }) {
  const { counts } = receipts;
  const standing = [
    counts.written > 0 ? count(counts.written, "deal written", "deals written") : null,
    counts.waiting > 0 ? `${counts.waiting} waiting` : null,
    counts.failed > 0 ? `${counts.failed} not written yet, tried again on their own` : null,
    counts.conflicts > 0 ? `${counts.conflicts} changed in HubSpot, waiting on you` : null,
    counts.refused > 0 ? `${counts.refused} not written` : null,
  ].filter((line): line is string => line !== null);
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <h3 className="text-sm font-semibold text-ink">Receipts in HubSpot</h3>
      <p className="max-w-prose text-sm text-ink-2">
        {receipts.on
          ? "On: each deal planned from HubSpot gets what it collected, what is still owed, the last receipt, the reconciliation status and a link to it in Vestiarion, in its Vestiarion fields in HubSpot. Only payments confirmed on Arc and applied to an invoice count."
          : "Write each deal's collections back to HubSpot, so sales sees whether the customer paid: what was collected from payments confirmed on Arc, what is still owed, the last receipt, the reconciliation status and a link to the deal in Vestiarion. Vestiarion never changes HubSpot's own fields, and never writes over a field someone changed there."}
      </p>
      {receipts.on && standing.length > 0 && <p className="text-sm text-ink-2">{standing.join(" · ")}.</p>}
      {receipts.on && !receipts.allowed && <p className="text-sm text-held">HubSpot has not allowed Vestiarion to write: nothing is written until it does.</p>}
      {receipts.account && <p className="text-sm text-ink-3">{receipts.account}</p>}
      {receipts.rule && <p className="max-w-prose text-sm text-ink-3">{receipts.rule}</p>}
      {canManage ? (
        <div className="flex flex-wrap items-start gap-3 pt-1">
          {!receipts.allowed && <ConnectButton orgSlug={orgSlug} label="Allow writing to HubSpot" write variant="secondary" />}
          {(receipts.on || receipts.allowed) && <ReceiptsSwitch orgSlug={orgSlug} on={receipts.on} />}
          {!receipts.allowed && (
            <p className="w-full max-w-prose text-sm text-ink-3">
              {HUBSPOT_WRITE_STEPS.tick} {HUBSPOT_WRITE_STEPS.locked}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-ink-3">An owner or admin turns writing to HubSpot on or off.</p>
      )}
    </div>
  );
}

/**
 * The HubSpot section of Settings (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H16, H17, H20), headed
 * by HubSpot's mark (docs/superpowers/specs/2026-10-12-integration-marks-design.md): its
 * status in business words, never "connected" while the last sync failed; the won deals to plan and the planned deals
 * changed in HubSpot, each linking to Bills & receivables; a reconnect when HubSpot no longer takes the connection; Sync
 * now and Disconnect HubSpot. Every member sees the status; an owner or admin gets the controls. `view` carries no token.
 */
export default function HubSpotPanel({
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
  /** Receipts written to HubSpot (CRM receipts R8); null before migration 0107, or once disconnected. */
  receipts?: CrmReceiptsPanel | null;
}) {
  const told = notice ? HUBSPOT_NOTICES[notice] : undefined;
  const deals = `/o/${orgSlug}${billsHref({ tab: "receivables" })}#from-hubspot`;
  return (
    <section aria-labelledby="hubspot-title" id="hubspot">
      <SectionHeader
        id="hubspot-title"
        // The mark has no text baseline: the title is a flex row, centred, so Docs sits level with it.
        className="items-center"
        title={
          <span className="flex items-center gap-2">
            <BrandMark brand="hubspot" />
            HubSpot
          </span>
        }
        action={<DocsLink href="/docs/guides/hubspot" topic="HubSpot" />}
      />
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
            {receipts && !view.revoked && <Receipts orgSlug={orgSlug} receipts={receipts} canManage={canManage} />}
            {canManage ? (
              <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4">
                {/* A reconnect keeps writing allowed when it is on: HubSpot is asked for the write scopes again. */}
                {view.status.reconnect && <ConnectButton orgSlug={orgSlug} label="Reconnect HubSpot" write={receipts?.on === true} />}
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
