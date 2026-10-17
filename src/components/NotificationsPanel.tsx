"use client";

import { useState } from "react";
import { flushSync } from "react-dom";
import { sendWeeklyBriefNowAction, setNotifyEmailAction, type NotifyEmailActionResult } from "@/app/actions/notifications";
import { Button } from "@/components/ui/Button";
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
function NotifyEmailSwitch({ orgSlug, initial, label, brief = false }: { orgSlug: string; initial: boolean; label: string; brief?: boolean }) {
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
          label={label}
        />
        {!state.ok && state.message && (
          <p role="alert" className="text-xs text-refused">
            {state.message}
          </p>
        )}
      </form>
      {brief && <SendBriefNow orgSlug={orgSlug} />}
    </Card>
  );
}

/**
 * This week's brief, sent at once to the viewer only (weekly brief W4): to see what Monday's email says.
 */
function SendBriefNow({ orgSlug }: { orgSlug: string }) {
  const { state, pending, formProps } = useActionForm(sendWeeklyBriefNowAction, INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <p className="min-w-0 flex-1 text-xs text-ink-2">In a live workspace it also sends a summary each Monday: what the agent did, what waits for you, what is due and whether the cash covers it.</p>
      <Button type="submit" size="sm" variant="secondary" loading={pending}>
        Send me this week&apos;s summary
      </Button>
      {!state.ok && state.message && (
        <p role="alert" className="w-full text-xs text-refused">
          {state.message}
        </p>
      )}
    </form>
  );
}

/**
 * The viewer's own notifications, first in Settings, for every member: the digest email for someone who decides
 * payments (a viewer decides nothing, so receives nothing), or for an accountant, who answers customers, the email
 * when a customer writes on its statement link (accountant console A1); and their own Telegram chat when this deployment has a bot
 * (Telegram bot design R1, R4). Nothing when neither applies. The workspace's Slack channel has its own section.
 */
export default function NotificationsPanel({
  orgSlug,
  canDecide,
  canAnswerCustomers = false,
  notifyEmail,
  telegram,
}: {
  orgSlug: string;
  /** Whether the viewer can decide payments: only then is there an email to switch. */
  canDecide: boolean;
  /** Whether the viewer answers customers without deciding payments (an accountant): their email is about customers. */
  canAnswerCustomers?: boolean;
  notifyEmail: boolean;
  /** The viewer's own Telegram chat for this workspace; null when this deployment has no bot. */
  telegram: { link: { username: string | null; linkedAt: string } | null } | null;
}) {
  const emailLabel = canDecide ? "Email me when payments need a decision" : canAnswerCustomers ? "Email me when a customer writes on its statement link" : null;
  if (!emailLabel && !telegram) return null;
  return (
    <section aria-labelledby="notifications-title" id="notifications">
      <SectionHeader
        id="notifications-title"
        title="Notifications"
        action={telegram ? <DocsLink href="/docs/guides/telegram" topic="Telegram notifications" /> : undefined}
      />
      <div className="space-y-4">
        {emailLabel && <NotifyEmailSwitch orgSlug={orgSlug} initial={notifyEmail} label={emailLabel} brief={canDecide} />}
        {telegram && <TelegramCard orgSlug={orgSlug} link={telegram.link} />}
      </div>
    </section>
  );
}
