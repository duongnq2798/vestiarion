"use client";

import { Plug, Send, Unplug } from "lucide-react";
import { connectDiscordAction, removeDiscordAction, sendDiscordTestAction, type DiscordActionResult } from "@/app/actions/discord";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { DocsLink } from "@/components/DocsLink";
import { utcMinute } from "@/lib/copy";
import type { DiscordPanelView } from "@/lib/discord/panel";

const INITIAL: DiscordActionResult = { ok: false, message: "" };
const REMOVE_FORM_ID = "remove-discord";

/** "Oct 22", the UTC day it was connected. */
function connectedOn(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function Refusal({ state }: { state: DiscordActionResult }) {
  return <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>;
}

type ActionForm = ReturnType<typeof useActionForm<DiscordActionResult>>;

/** The webhook's URL, pasted once: posted to with a test message, and saved only if Discord took it (DC1). */
function ConnectForm({ orgSlug, form }: { orgSlug: string; form: ActionForm }) {
  const { state, formProps } = form;
  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <Field
        id="discord-webhook-url"
        label="Webhook URL"
        description="In Discord: the channel's settings, then Integrations, Webhooks, New Webhook, and Copy Webhook URL."
      >
        <Input name="webhookUrl" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://discord.com/api/webhooks/…" required />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" pendingLabel="Connecting…" icon={<Plug aria-hidden />}>
          Connect
        </SubmitButton>
        <Refusal state={state} />
      </div>
    </form>
  );
}

function SendTest({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(sendDiscordTestAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Sending…" icon={<Send aria-hidden />}>
        Send test message
      </SubmitButton>
      <Refusal state={state} />
    </form>
  );
}

function Disconnect({ orgSlug, form }: { orgSlug: string; form: ActionForm }) {
  const { state, pending, formProps } = form;
  return (
    <form id={REMOVE_FORM_ID} {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <ConfirmDialog
        formId={REMOVE_FORM_ID}
        trigger={
          <Button variant="secondary" size="sm" icon={<Unplug aria-hidden />} loading={pending}>
            Disconnect
          </Button>
        }
        title="Disconnect Discord?"
        description="Bills waiting for approval are no longer posted to the channel, and Vestiarion deletes the webhook's URL. The webhook itself stays in the channel's settings in Discord until someone deletes it there."
        confirmLabel="Disconnect Discord"
      />
      <Refusal state={state} />
    </form>
  );
}

/**
 * The Discord section of Settings (docs/superpowers/specs/2026-10-22-discord-design.md DC6). Before migration 0139 it
 * says Discord is not set up yet. Not connected: an owner or admin pastes a channel webhook's URL and connects it.
 * Connected: the webhook's name and channel, when it was connected, and the last post Discord did not take; an owner or
 * admin sends a test message or disconnects it. Anyone else sees the status and who can connect it. `view` carries no
 * URL. Connect and Disconnect keep their results here, in the panel the page keeps mounted: the revalidated page swaps
 * the form that was submitted for the other one in the same render, and its toast would go with it.
 */
export default function DiscordPanel({ orgSlug, view, canManage }: { orgSlug: string; view: DiscordPanelView; canManage: boolean }) {
  const connect = useActionForm(connectDiscordAction, INITIAL, { toastOnSuccess: true, resetOnSuccess: true });
  const disconnect = useActionForm(removeDiscordAction, INITIAL, { toastOnSuccess: true });
  return (
    <section aria-labelledby="discord-title" id="discord">
      <SectionHeader id="discord-title" title="Discord" action={<DocsLink href="/docs/guides/discord" topic="Discord" />} />
      <Card className="space-y-4 p-5">
        {!view.available ? (
          <p className="max-w-prose text-sm text-ink-2">Discord is not set up on this deployment yet.</p>
        ) : !view.connected ? (
          <div className="max-w-prose space-y-3">
            <p className="text-sm text-ink-2">
              Post the bills the agent holds for approval to a Discord channel, each with a link to review it in Vestiarion. Opening a link
              never approves anything: bills are approved in Vestiarion.
            </p>
            {canManage ? <ConnectForm orgSlug={orgSlug} form={connect} /> : <p className="text-sm text-ink-3">An owner or admin can connect Discord.</p>}
          </div>
        ) : (
          <div className="space-y-4 [&>*+*]:border-t [&>*+*]:border-line [&>*+*]:pt-4">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm [&_dd]:break-words">
              <dt className="text-ink-2">Webhook</dt>
              <dd className="font-medium text-ink">{view.name}</dd>
              <dt className="text-ink-2">Channel id</dt>
              <dd className="font-mono text-xs leading-5 text-ink">{view.channelId}</dd>
              <dt className="text-ink-2">Connected since</dt>
              <dd className="text-ink">{view.connectedByYou ? `${connectedOn(view.connectedAt)}, by you` : connectedOn(view.connectedAt)}</dd>
              {view.lastError && (
                <>
                  <dt className="text-ink-2">Last error</dt>
                  <dd className="text-refused">
                    {view.lastErrorAt ? `${utcMinute(view.lastErrorAt)}: ` : ""}
                    {view.lastError}
                  </dd>
                </>
              )}
            </dl>
            <p className="max-w-prose text-sm text-ink-2">
              Bills the agent holds or flags for approval are posted to this channel after each cycle, each with a link to review it. Opening a link
              never approves anything.
            </p>
            {canManage ? (
              <div className="flex flex-wrap items-start gap-3">
                <SendTest orgSlug={orgSlug} />
                <Disconnect orgSlug={orgSlug} form={disconnect} />
              </div>
            ) : (
              <p className="text-sm text-ink-3">An owner or admin can connect Discord.</p>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}
