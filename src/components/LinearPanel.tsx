"use client";

import { Link2, RefreshCw, SquareKanban, Unplug } from "lucide-react";
import Link from "next/link";
import { disconnectLinearAction, syncLinearNowAction, type LinearActionResult } from "@/app/actions/linear";
import { DocsLink } from "@/components/DocsLink";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";
import type { LinearPanelView } from "@/lib/linear/views";

const INITIAL: LinearActionResult = { ok: false, message: "" };
/**
 * Disconnect's answer is a toast the action raises itself: the revalidated page drops the button in the same render
 * (docs/superpowers/specs/2026-10-27-disconnect-confirmation-design.md DC1).
 */
const disconnect = withSuccessToast(disconnectLinearAction);

/** What Linear's way back from connecting says, by the code it carries in `?linear=` (Linear acceptance LN2). */
export const LINEAR_NOTICES: Record<string, { tone: "success" | "error"; text: string }> = {
  connected: { tone: "success", text: "Linear is connected. Link a milestone to its Linear issue on Contractors." },
  cancelled: { tone: "error", text: "Connecting Linear was cancelled. Nothing changed." },
  forbidden: { tone: "error", text: "Only an owner or admin connects Linear, from their own browser." },
  other_organisation: { tone: "error", text: "This workspace is connected to another Linear workspace. Disconnect it first, then connect the one you want." },
  not_set_up: { tone: "error", text: "Linear is not set up on this deployment yet." },
  failed: { tone: "error", text: "Linear did not finish connecting. Try again in a moment." },
};

function SyncNow({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(syncLinearNowAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Checking…" icon={<RefreshCw aria-hidden />}>
        Check linked issues now
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
        Disconnect Linear
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

function ConnectButton({ orgSlug, label }: { orgSlug: string; label: string }) {
  return (
    <Button asChild size="sm">
      <Link href={`/integrations/linear/connect?org=${orgSlug}`}>
        <Link2 aria-hidden />
        {label}
      </Link>
    </Button>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The Linear section of Settings (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN2, LN15, LN16), as
 * Asana's (`AsanaPanel`): its status in business words, naming the Linear workspace connected; the issues linked to
 * milestones by where they stand, linking to Contractors; the last 30 days' figures (acceptances, which are each a
 * person's check of the evidence; acceptances taken back; the time from an acceptance to the agent's decision); Check
 * linked issues now and Disconnect Linear. Every member sees the status; an owner or admin gets the controls. Headed by
 * Linear's name beside the product's icon for work tools: Linear's logo is not shipped yet (LN16).
 */
export default function LinearPanel({ orgSlug, view, canManage, notice }: { orgSlug: string; view: LinearPanelView; canManage: boolean; notice: string | null }) {
  const told = notice ? LINEAR_NOTICES[notice] : undefined;
  return (
    <section aria-labelledby="linear-title" id="linear">
      <SectionHeader
        id="linear-title"
        className="items-center"
        title={
          <span className="inline-flex items-center gap-2">
            <SquareKanban aria-hidden className="size-5 text-ink-2" />
            Linear
          </span>
        }
        action={<DocsLink href="/docs/guides/linear" topic="Linear" />}
      />
      <Card className="space-y-4 p-5">
        {told && (
          <p role="status" className={told.tone === "success" ? "text-sm text-ink" : "text-sm text-refused"}>
            {told.text}
          </p>
        )}
        {view.state === "not_set_up" ? (
          <p className="text-sm text-ink-2">Linear is not set up on this deployment yet.</p>
        ) : view.state === "not_connected" ? (
          <div className="max-w-prose space-y-3">
            <p className="text-sm text-ink-2">
              Pay contractors for work delivered in Linear. Link a milestone to its Linear issue; when the issue is done, a person accepts the work against
              the milestone&apos;s criteria, and only then does the agent decide on pay. An issue marked done alone never pays, and an issue reopened or
              changed after acceptance is held for review when Vestiarion reads it before the payment is sent.
            </p>
            {canManage ? <ConnectButton orgSlug={orgSlug} label="Connect Linear" /> : <p className="text-sm text-ink-3">An owner or admin connects Linear.</p>}
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
                    "No milestone is linked to a Linear issue yet."
                  ) : (
                    <Link className="font-medium text-agent underline-offset-4 hover:underline" href={`/o/${orgSlug}/contractors`}>
                      {count(view.counts.linked, "issue linked to a milestone", "issues linked to milestones")}
                    </Link>
                  )}
                </li>
                {view.counts.ready > 0 && <li className="text-agent">{count(view.counts.ready, "issue ready for acceptance", "issues ready for acceptance")}</li>}
                {view.counts.held > 0 && <li className="text-held">{count(view.counts.held, "issue held for review", "issues held for review")}</li>}
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
                {view.status.reconnect && <ConnectButton orgSlug={orgSlug} label="Reconnect Linear" />}
                {view.revoked && <ConnectButton orgSlug={orgSlug} label="Connect Linear" />}
                {view.connected && <SyncNow orgSlug={orgSlug} />}
                {!view.revoked && <Disconnect orgSlug={orgSlug} />}
              </div>
            ) : (
              <p className="text-sm text-ink-3">An owner or admin manages Linear.</p>
            )}
          </>
        )}
      </Card>
    </section>
  );
}
