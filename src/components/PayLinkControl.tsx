"use client";

import { BellOff, BellRing, Link2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { createPayLinkAction, setRemindersAction, type PayLinkActionResult } from "@/app/actions/pay-links";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { orgHref } from "@/lib/auth/org-paths";
import { EARLIEST_DAYS_BEFORE_DUE, MAX_REMINDERS, MIN_DAYS_BETWEEN, type SentReminder } from "@/lib/collections";
import { utcDay } from "@/lib/copy";
import { counterpartyPath } from "@/lib/next-step";

const INITIAL: PayLinkActionResult = { ok: false, message: "" };

/** What the page read about the receivable's link and reminders (collections R1, R2); null when it has no link. */
export interface PayLinkView {
  url: string | null;
  legacy: boolean;
  remindersOnAt: string | null;
  deferredUntil: string | null;
  sent: SentReminder[];
}

/** What the reminders did so far, in a sentence or two. */
export function remindersSoFar(view: PayLinkView, dueDate: string, clientName: string, now: number = Date.now()): string {
  const last = view.sent[view.sent.length - 1];
  if (last && (last.tone === "final" || view.sent.length >= MAX_REMINDERS)) {
    return `The agent sent its last reminder on ${utcDay(last.sentAt)}. Follow up with ${clientName} yourself.`;
  }
  const sent =
    view.sent.length === 0
      ? "Reminders are on. None sent yet"
      : `Reminders are on. Sent: ${view.sent.map((reminder) => `${utcDay(reminder.sentAt)} (${reminder.tone})`).join(", ")}`;
  if (view.deferredUntil && Date.parse(view.deferredUntil) > now) return `${sent}. The agent waits until ${utcDay(view.deferredUntil)} before deciding again.`;
  const earliest = Date.parse(dueDate) - EARLIEST_DAYS_BEFORE_DUE * 86_400_000;
  if (view.sent.length === 0 && earliest > now) {
    return `${sent}. The agent decides from ${utcDay(new Date(earliest).toISOString())}, ${EARLIEST_DAYS_BEFORE_DUE} days before the due date.`;
  }
  return `${sent}.`;
}

/**
 * An open receivable's pay link and the agent's reminders (docs/superpowers/specs/2026-10-01-receivables-on-arc-design.md
 * §2, 2026-10-03-collections-design.md R1–R2): the link, kept so it can be copied again, and, with the client's
 * billing email, Remind the client by email. Once the client pays the exact amount on Arc testnet, the agent matches
 * the transfer and the receivable is received.
 */
export function PayLinkControl({
  orgSlug,
  invoiceId,
  view = null,
  dueDate,
  client,
}: {
  orgSlug: string;
  invoiceId: string;
  view?: PayLinkView | null;
  dueDate: string;
  client: { id: string; name: string; hasEmail: boolean };
}) {
  const [made, setMade] = useState<string | null>(null);
  const link = useActionForm(createPayLinkAction, INITIAL, { onResult: (result) => setMade(result.ok && result.url ? result.url : null) });
  const reminders = useActionForm(setRemindersAction, INITIAL, { toastOnSuccess: true });
  const url = made ?? view?.url ?? null;
  const on = view?.remindersOnAt != null;

  return (
    <div className="grid gap-3">
      <form {...link.formProps} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="invoiceId" value={invoiceId} />
        <SubmitButton variant="secondary" size="sm" icon={<Link2 />} pendingLabel="Making a link…">
          {url || view ? "Make a new link" : "Get paid on Arc"}
        </SubmitButton>
        {!link.state.ok && link.state.message && <FormMessage tone="error">{link.state.message}</FormMessage>}
      </form>
      {url ? (
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <Input readOnly value={url} aria-label="Pay link" className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
            <CopyButton value={url} label="Copy link" variant="secondary">
              Copy link
            </CopyButton>
          </div>
          <p className="text-xs text-ink-3">
            Send it to your client. They pay the exact amount on Arc testnet, and the agent matches it to this invoice. A new link replaces this one.
          </p>
        </div>
      ) : view?.legacy ? (
        <p className="text-xs text-ink-3">This receivable has a link made before links could be shown again. Make a new link to copy it; the old one then stops working.</p>
      ) : null}

      <div className="grid gap-2 border-t border-line pt-3">
        <p className="text-sm font-medium text-ink">Reminders</p>
        {client.hasEmail ? (
          <form {...reminders.formProps} className="grid gap-2">
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <input type="hidden" name="invoiceId" value={invoiceId} />
            <input type="hidden" name="on" value={on ? "false" : "true"} />
            <p className="text-xs leading-5 text-ink-3">
              {on && view
                ? remindersSoFar(view, dueDate, client.name)
                : `Let the agent remind ${client.name} by email, with the pay link. It decides when and how firmly: from ${EARLIEST_DAYS_BEFORE_DUE} days before the due date, at most every ${MIN_DAYS_BETWEEN} days, up to ${MAX_REMINDERS} reminders, and it stops once ${client.name} pays.`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <SubmitButton variant="secondary" size="sm" icon={on ? <BellOff /> : <BellRing />} pendingLabel={on ? "Turning off…" : "Turning on…"}>
                {on ? "Turn off reminders" : "Remind the client by email"}
              </SubmitButton>
              {!reminders.state.ok && reminders.state.message && <FormMessage tone="error">{reminders.state.message}</FormMessage>}
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs leading-5 text-ink-3">Add {client.name}&apos;s billing email on Counterparties to let the agent remind them of this invoice.</p>
            <Button asChild size="sm" variant="secondary">
              <Link href={orgHref(orgSlug, counterpartyPath(client.id))}>Add billing email</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
