"use client";

import { useState } from "react";
import { flushSync } from "react-dom";
import { setNotifyEmailAction, type NotifyEmailActionResult } from "@/app/actions/notifications";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { useActionForm } from "@/components/ui/useActionForm";
import { TelegramCard } from "@/components/TelegramCard";
import { DocsLink } from "@/components/DocsLink";

const INITIAL: NotifyEmailActionResult = { ok: false, message: "" };

/**
 * The viewer's own switch for the waiting-decision digest (spec N6). It saves itself when changed: the checkbox shows
 * the requested state while the change is on its way, and the server's answer afterwards, reverted to `initial` on a
 * refusal.
 */
function NotifyEmailSwitch({ orgSlug, initial }: { orgSlug: string; initial: boolean }) {
  const [requested, setRequested] = useState(initial);
  const { state, pending, formProps } = useActionForm(setNotifyEmailAction, INITIAL, { toastOnSuccess: true });

  return (
    <Card className="p-4 sm:p-5">
      <form {...formProps} className="flex flex-col gap-1">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="on" value={requested ? "true" : "false"} />
        <Checkbox
          checked={pending ? requested : initial}
          disabled={pending}
          onCheckedChange={(checked) => {
            // The hidden input must hold the requested value before the form reads it.
            flushSync(() => setRequested(checked === true));
            formProps.ref.current?.requestSubmit();
          }}
          label="Email me when payments need a decision"
        />
        {!state.ok && state.message && (
          <p role="alert" className="text-xs text-refused">
            {state.message}
          </p>
        )}
      </form>
    </Card>
  );
}

/**
 * The viewer's own notifications, first in Settings, for every member: the digest email for someone who decides
 * payments (a viewer decides nothing, so receives nothing), and their own Telegram chat when this deployment has a bot
 * (Telegram bot design R1, R4). Nothing when neither applies. The workspace's Slack channel has its own section.
 */
export default function NotificationsPanel({
  orgSlug,
  canDecide,
  notifyEmail,
  telegram,
}: {
  orgSlug: string;
  /** Whether the viewer can decide payments: only then is there an email to switch. */
  canDecide: boolean;
  notifyEmail: boolean;
  /** The viewer's own Telegram chat for this workspace; null when this deployment has no bot. */
  telegram: { link: { username: string | null; linkedAt: string } | null } | null;
}) {
  if (!canDecide && !telegram) return null;
  return (
    <section aria-labelledby="notifications-title" id="notifications">
      <SectionHeader
        id="notifications-title"
        title="Notifications"
        action={telegram ? <DocsLink href="/docs/guides/telegram" topic="Telegram notifications" /> : undefined}
      />
      <div className="space-y-4">
        {canDecide && <NotifyEmailSwitch orgSlug={orgSlug} initial={notifyEmail} />}
        {telegram && <TelegramCard orgSlug={orgSlug} link={telegram.link} />}
      </div>
    </section>
  );
}
