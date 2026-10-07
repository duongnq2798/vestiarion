"use client";

import { Link2Off, Send } from "lucide-react";
import { connectTelegramAction, disconnectTelegramAction, type TelegramActionResult } from "@/app/actions/telegram";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { BrandMark } from "@/components/vx/BrandMarks";

const INITIAL: TelegramActionResult = { ok: false, message: "" };

/** "Oct 3", the UTC day the chat was connected. */
function connectedOn(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function Refusal({ state }: { state: TelegramActionResult }) {
  if (state.ok || !state.message) return null;
  return (
    <p role="alert" className="text-xs text-refused">
      {state.message}
    </p>
  );
}

/**
 * The viewer's own Telegram chat for this workspace (Telegram bot design R4, R6), in Settings' Notifications section
 * beside the email switch. Not connected: a button that makes a one-time link to the bot, and once it is made, the
 * link, with the page re-read every 5 s so the card turns to connected as soon as the chat claims it. Connected: which
 * Telegram account, since when, and a button to disconnect it.
 */
export function TelegramCard({ orgSlug, link }: { orgSlug: string; link: { username: string | null; linkedAt: string } | null }) {
  const connect = useActionForm(connectTelegramAction, INITIAL);
  const leave = useActionForm(disconnectTelegramAction, INITIAL, { toastOnSuccess: true });

  if (link) {
    return (
      <Card className="p-4 sm:p-5">
        <form {...leave.formProps} className="flex flex-wrap items-center justify-between gap-3">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <div className="min-w-0 max-w-prose space-y-1">
            <p className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
              <BrandMark brand="telegram" className="size-4 text-ink-2" />
              Telegram
            </p>
            <p className="text-sm text-ink-2">
              Connected{link.username ? ` as @${link.username}` : ""} since {connectedOn(link.linkedAt)}. The agent&apos;s decisions in this
              workspace are sent there, and invoices you send the bot can be added as payables.
            </p>
          </div>
          <SubmitButton variant="secondary" size="sm" pendingLabel="Disconnecting…" icon={<Link2Off aria-hidden />}>
            Disconnect
          </SubmitButton>
        </form>
        <Refusal state={leave.state} />
      </Card>
    );
  }

  const url = connect.state.ok ? connect.state.url : undefined;
  return (
    <Card className="p-4 sm:p-5">
      <form {...connect.formProps} className="flex flex-col gap-3">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <div className="max-w-prose space-y-1">
          <p className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
            <BrandMark brand="telegram" className="size-4 text-ink-2" />
            Telegram
          </p>
          <p className="text-sm text-ink-2">
            Get the agent&apos;s decisions in your own Telegram chat, ask what is waiting or safe to spend, and send it invoices to add. The bot
            never approves or pays: that stays here.
          </p>
        </div>
        {url ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild size="sm">
              <a href={url} target="_blank" rel="noopener noreferrer">
                <Send aria-hidden />
                Open Telegram
              </a>
            </Button>
            <p className="text-xs text-ink-3">The link works once, for 10 minutes. This card shows the connection as soon as it is made.</p>
            <AutoRefresh intervalMs={5_000} />
          </div>
        ) : (
          <div>
            <SubmitButton variant="secondary" size="sm" pendingLabel="Making a link…" icon={<Send aria-hidden />}>
              Connect Telegram
            </SubmitButton>
          </div>
        )}
        <Refusal state={connect.state} />
      </form>
    </Card>
  );
}
