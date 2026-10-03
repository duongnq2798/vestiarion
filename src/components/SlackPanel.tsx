"use client";

import { Hash, Link2Off, Unplug } from "lucide-react";
import {
  disconnectSlackAccountAction, removeSlackAction, setSlackDecisionsLimitAction, type SlackActionResult,
} from "@/app/actions/slack";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { SlackPanelView } from "@/lib/slack/panel";

const INITIAL: SlackActionResult = { ok: false, message: "" };

/** What Slack's way back from connecting says, by the code it carries in `?slack=` (Slack design S3). */
export const SLACK_NOTICES: Record<string, { tone: "success" | "error"; text: string }> = {
  connected: { tone: "success", text: "Slack is connected. The agent's decisions now go to the channel you picked." },
  cancelled: { tone: "error", text: "Connecting Slack was cancelled. Nothing changed." },
  forbidden: { tone: "error", text: "Only an owner or admin connects Slack, from their own browser." },
  team_taken: { tone: "error", text: "That Slack workspace is already connected to another Vestiarion workspace." },
  enterprise_install: { tone: "error", text: "Vestiarion connects one Slack workspace at a time, not a whole Enterprise Grid organization." },
  missing_webhook: { tone: "error", text: "Pick a channel for the agent's decisions when Slack asks, then try again." },
  slack_refused: { tone: "error", text: "Slack did not finish connecting. Try again in a moment." },
  malformed: { tone: "error", text: "Slack did not finish connecting. Try again in a moment." },
  unreachable: { tone: "error", text: "Slack could not be reached. Try again in a moment." },
};

/** "Oct 3", the UTC day it was connected. */
function connectedOn(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function Refusal({ state }: { state: SlackActionResult }) {
  return <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>;
}

function LimitForm({ orgSlug, limit }: { orgSlug: string; limit: number | null }) {
  const { state, formProps } = useActionForm(setSlackDecisionsLimitAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <p className="text-xs leading-5 text-ink-3">Leave the amount empty to turn deciding from Slack off.</p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field id="slack-decisions-limit" label="Limit (USDC)" optional>
          <Input name="limit" inputMode="decimal" autoComplete="off" defaultValue={limit ?? ""} className="sm:w-40" />
        </Field>
        <SubmitButton variant="secondary" pendingLabel="Saving…">
          Save
        </SubmitButton>
        <FormMessage className="sm:self-center" tone={state.message && !state.ok ? "error" : "neutral"}>
          {state.ok ? null : state.message}
        </FormMessage>
      </div>
    </form>
  );
}

function DisconnectMine({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(disconnectSlackAccountAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Disconnecting…" icon={<Link2Off aria-hidden />}>
        Disconnect my account
      </SubmitButton>
      <Refusal state={state} />
    </form>
  );
}

function RemoveSlack({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(removeSlackAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Removing…" icon={<Unplug aria-hidden />}>
        Remove Slack
      </SubmitButton>
      <Refusal state={state} />
    </form>
  );
}

/**
 * The Slack section of Settings (docs/superpowers/specs/2026-10-03-slack-design.md S3, S4, S8, S13). Not connected: an
 * owner or admin gets Add to Slack, which goes through the install route. Connected: the Slack workspace and channel,
 * how a member connects their own account (and the viewer's own state), the limit on deciding payments from Slack,
 * which only an owner changes, and Remove for an owner or admin. `view` carries no secret.
 */
export default function SlackPanel({
  orgSlug,
  view,
  canManage,
  canAdminister,
  notice,
}: {
  orgSlug: string;
  view: SlackPanelView;
  canManage: boolean;
  canAdminister: boolean;
  notice: string | null;
}) {
  const told = notice ? SLACK_NOTICES[notice] : undefined;
  return (
    <section aria-labelledby="slack-title" id="slack">
      <SectionHeader id="slack-title" title="Slack" />
      <Card className="space-y-4 p-5">
        {told && (
          <p role="status" className={told.tone === "success" ? "text-sm text-ink" : "text-sm text-refused"}>
            {told.text}
          </p>
        )}
        {!view.installed ? (
          <div className="max-w-prose space-y-3">
            <p className="text-sm text-ink-2">
              Send the agent&apos;s decisions to a Slack channel your team picks. Members ask what is safe to spend or what waits with
              /vestiarion, and pause the agent from there. When an owner allows it, a payment the agent stopped is decided from its message.
            </p>
            {canManage ? (
              <Button asChild size="sm">
                <a href={`/api/slack/install?org=${orgSlug}`}>
                  <Hash aria-hidden />
                  Add to Slack
                </a>
              </Button>
            ) : (
              <p className="text-sm text-ink-3">An owner or admin connects Slack.</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="max-w-prose text-sm text-ink-2">
              Connected to <strong className="font-semibold text-ink">{view.teamName ?? "a Slack workspace"}</strong> since{" "}
              {connectedOn(view.installedAt)}. The agent&apos;s decisions go to{" "}
              <strong className="font-semibold text-ink">{view.channelName ?? "the channel picked"}</strong>.
            </p>
            {!view.canReadFiles && (
              <p className="max-w-prose text-sm text-ink-2">
                To add invoices from Slack, connect Slack again: Vestiarion now also asks to read the file someone chooses with Add invoice,
                and nothing else.
              </p>
            )}
            <div className="max-w-prose space-y-2">
              <p className="text-sm font-medium text-ink">Your Slack account</p>
              {view.youConnected ? (
                <>
                  <p className="text-sm text-ink-2">Your Slack account is connected: /vestiarion and the buttons in Slack act as you, with your role here.</p>
                  <DisconnectMine orgSlug={orgSlug} />
                </>
              ) : (
                <p className="text-sm text-ink-2">
                  In Slack, type <code className="font-mono text-xs">/vestiarion connect</code> and open the link it gives you. Each member connects
                  their own account.
                </p>
              )}
            </div>
            <div className="max-w-prose space-y-2">
              <p className="text-sm font-medium text-ink">Deciding payments from Slack</p>
              <p className="text-sm text-ink-2">
                {view.decisionsLimitUsdc === null
                  ? "Deciding payments from Slack is off: a payment the agent stopped links to Approvals."
                  : `Anyone who may approve can approve and pay a stopped payment from Slack up to ${view.decisionsLimitUsdc} USDC, in USDC on Arc, to a confirmed address. Reject and Return work at any amount.`}
              </p>
              {canAdminister && <LimitForm orgSlug={orgSlug} limit={view.decisionsLimitUsdc} />}
            </div>
            {canManage && (
              <div className="max-w-prose space-y-3">
                <p className="text-xs leading-5 text-ink-3">
                  Reconnect to pick another channel, or to grant what Vestiarion asks of Slack. Members stay connected, and the limit stays.
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <Button asChild size="sm" variant="secondary">
                    <a href={`/api/slack/install?org=${orgSlug}`}>
                      <Hash aria-hidden />
                      Reconnect Slack
                    </a>
                  </Button>
                  <RemoveSlack orgSlug={orgSlug} />
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}
