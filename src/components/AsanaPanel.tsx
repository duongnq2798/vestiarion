"use client";

import { Link2, RefreshCw, Unplug } from "lucide-react";
import Link from "next/link";
import { disconnectAsanaAction, syncAsanaNowAction, type AsanaActionResult } from "@/app/actions/asana";
import { DocsLink } from "@/components/DocsLink";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { AsanaPanelView } from "@/lib/asana/views";

const INITIAL: AsanaActionResult = { ok: false, message: "" };

/** What Asana's way back from connecting says, by the code it carries in `?asana=` (Asana acceptance A2). */
export const ASANA_NOTICES: Record<string, { tone: "success" | "error"; text: string }> = {
  connected: { tone: "success", text: "Asana is connected. Link a milestone to its Asana task on Contractors." },
  cancelled: { tone: "error", text: "Connecting Asana was cancelled. Nothing changed." },
  forbidden: { tone: "error", text: "Only an owner or admin connects Asana, from their own browser." },
  other_organisation: { tone: "error", text: "This workspace is connected to another person's Asana. Disconnect it first, then connect the one you want." },
  not_set_up: { tone: "error", text: "Asana is not set up on this deployment yet." },
  failed: { tone: "error", text: "Asana did not finish connecting. Try again in a moment." },
};

function SyncNow({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(syncAsanaNowAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Checking…" icon={<RefreshCw aria-hidden />}>
        Check linked tasks now
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

function Disconnect({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(disconnectAsanaAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Disconnecting…" icon={<Unplug aria-hidden />}>
        Disconnect Asana
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

function ConnectButton({ orgSlug, label }: { orgSlug: string; label: string }) {
  return (
    <Button asChild size="sm">
      <Link href={`/integrations/asana/connect?org=${orgSlug}`}>
        <Link2 aria-hidden />
        {label}
      </Link>
    </Button>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The Asana section of Settings (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A2, A14, A16): its status
 * in business words; the tasks linked to milestones by where they stand, linking to Contractors; the last 30 days'
 * figures (acceptances, which are each a person's check of the evidence; acceptances taken back; the time from an
 * acceptance to the agent's decision); Check linked tasks now and Disconnect Asana. Every member sees the status; an
 * owner or admin gets the controls. Asana's name stands alone: its mark is not in this repository yet.
 */
export default function AsanaPanel({ orgSlug, view, canManage, notice }: { orgSlug: string; view: AsanaPanelView; canManage: boolean; notice: string | null }) {
  const told = notice ? ASANA_NOTICES[notice] : undefined;
  return (
    <section aria-labelledby="asana-title" id="asana">
      <SectionHeader id="asana-title" className="items-center" title="Asana" action={<DocsLink href="/docs/guides/asana" topic="Asana" />} />
      <Card className="space-y-4 p-5">
        {told && (
          <p role="status" className={told.tone === "success" ? "text-sm text-ink" : "text-sm text-refused"}>
            {told.text}
          </p>
        )}
        {view.state === "not_set_up" ? (
          <p className="text-sm text-ink-2">Asana is not set up on this deployment yet.</p>
        ) : view.state === "not_connected" ? (
          <div className="max-w-prose space-y-3">
            <p className="text-sm text-ink-2">
              Pay contractors for work delivered in Asana. Link a milestone to its Asana task; when the task is completed, a person accepts the work
              against the milestone&apos;s criteria, and only then does the agent decide on pay. A completed task alone never pays, and a task reopened or
              changed after acceptance is held for review before any payment.
            </p>
            {canManage ? <ConnectButton orgSlug={orgSlug} label="Connect Asana" /> : <p className="text-sm text-ink-3">An owner or admin connects Asana.</p>}
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
                  {view.counts.linked === 0 ? (
                    "No milestone is linked to an Asana task yet."
                  ) : (
                    <Link className="font-medium text-agent underline-offset-4 hover:underline" href={`/o/${orgSlug}/contractors`}>
                      {count(view.counts.linked, "task linked to a milestone", "tasks linked to milestones")}
                    </Link>
                  )}
                </li>
                {view.counts.ready > 0 && <li className="text-agent">{count(view.counts.ready, "task ready for acceptance", "tasks ready for acceptance")}</li>}
                {view.counts.held > 0 && <li className="text-held">{count(view.counts.held, "task held for review", "tasks held for review")}</li>}
              </ul>
            )}
            <div className="space-y-1 border-t border-line pt-4">
              <h3 className="text-sm font-semibold text-ink">In {view.figures.window}</h3>
              <dl className="grid grid-cols-1 gap-2 text-sm min-[420px]:grid-cols-3">
                <div>
                  <dt className="text-xs text-ink-3">Evidence checked by a person</dt>
                  <dd className="font-semibold tabular-nums text-ink">{count(view.figures.manualChecks, "acceptance", "acceptances")}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-3">Disputes</dt>
                  <dd className="font-semibold tabular-nums text-ink">{count(view.figures.disputes, "acceptance taken back", "acceptances taken back")}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-3">From acceptance to the agent&apos;s decision</dt>
                  <dd className="font-semibold tabular-nums text-ink">{view.figures.timeToProposal ?? "Not yet"}</dd>
                </div>
              </dl>
            </div>
            {canManage ? (
              <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4">
                {view.status.reconnect && <ConnectButton orgSlug={orgSlug} label="Reconnect Asana" />}
                {view.revoked && <ConnectButton orgSlug={orgSlug} label="Connect Asana" />}
                {view.connected && <SyncNow orgSlug={orgSlug} />}
                {!view.revoked && <Disconnect orgSlug={orgSlug} />}
              </div>
            ) : (
              <p className="text-sm text-ink-3">An owner or admin manages Asana.</p>
            )}
          </>
        )}
      </Card>
    </section>
  );
}
