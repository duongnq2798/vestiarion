"use client";

import { Send, UserPlus } from "lucide-react";
import { useState } from "react";
import {
  inviteMemberAction,
  type MemberActionResult,
} from "@/app/actions/members";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { ROLE_SUMMARIES } from "@/lib/auth/roles";
import { inviteLaterCookie } from "@/lib/invite-nudge";

/**
 * Bring in a second person, on Treasury (docs/superpowers/specs/2026-10-19-invite-nudge-design.md I1-I3, I6): an owner
 * or admin who runs the workspace alone invites an approver or an accountant from here, through the usual invitation.
 * "Not now" puts it off in this browser for 30 days. The page keeps it in place for whoever may invite, so an invitation
 * just sent stays on screen after the page re-reads and no longer counts the workspace as one person's.
 */

const INITIAL: MemberActionResult = { ok: false, message: "" };

export const APPROVER_REASON =
  "Decides the payments the agent holds. With a second person, a first payment to an address you gave goes to them, not to you alone.";

const ROWS = [
  { role: "approver", title: "An approver", reason: APPROVER_REASON },
  {
    role: "accountant",
    title: "Your accountant",
    reason: ROLE_SUMMARIES.accountant,
  },
] as const;

export function InviteNudge({
  orgSlug,
  shown,
}: {
  orgSlug: string;
  shown: boolean;
}) {
  const [later, setLater] = useState(false);
  const [sent, setSent] = useState(false);
  if (later || (!shown && !sent)) return null;

  const putOff = () => {
    try {
      document.cookie = inviteLaterCookie(
        orgSlug,
        window.location.protocol === "https:",
      );
    } catch {
      // A browser that refuses the cookie still hides the card until the page loads again.
    }
    setLater(true);
  };

  return (
    <Card asChild className="mb-8 space-y-4 p-4 sm:p-5">
      <section aria-labelledby="invite-nudge-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <h2
              id="invite-nudge-title"
              className="flex items-center gap-2 text-sm font-semibold text-ink"
            >
              <UserPlus aria-hidden className="size-4 text-agent" />
              Bring in a second person
            </h2>
            <p className="text-sm text-ink-2">
              You run this workspace alone. Invite the people who should decide
              or read what the agent does.
            </p>
          </div>
          {!sent && (
            <Button variant="ghost" size="sm" onClick={putOff}>
              Not now
            </Button>
          )}
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {ROWS.map((row) => (
            <InviteRow
              key={row.role}
              orgSlug={orgSlug}
              role={row.role}
              title={row.title}
              reason={row.reason}
              onSent={() => setSent(true)}
            />
          ))}
        </div>
      </section>
    </Card>
  );
}

function InviteRow({
  orgSlug,
  role,
  title,
  reason,
  onSent,
}: {
  orgSlug: string;
  role: "approver" | "accountant";
  title: string;
  reason: string;
  onSent: () => void;
}) {
  const { state, formProps } = useActionForm(inviteMemberAction, INITIAL, {
    resetOnSuccess: true,
    onSuccess: onSent,
  });
  const id = `invite-nudge-${role}`;
  return (
    <form
      {...formProps}
      className="space-y-2 rounded-xl border border-line p-3"
    >
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="role" value={role} />
      <input type="hidden" name="via" value="console_nudge" />
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="text-xs leading-5 text-ink-2">{reason}</p>
      </div>
      <div className="flex items-end gap-2">
        <Field id={id} label="Email" className="min-w-0 flex-1">
          <Input
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder="name@company.com"
            size="sm"
          />
        </Field>
        <SubmitButton
          icon={<Send />}
          pendingLabel="Inviting…"
          size="sm"
          className="shrink-0"
        >
          Invite
        </SubmitButton>
      </div>
      <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
      {state.ok && (
        <div
          className="rounded-lg border border-agent-line bg-agent-soft p-2.5"
          role="status"
        >
          <p className="text-xs font-medium text-agent">{state.message}</p>
          {state.link && (
            <div className="mt-2 flex items-center gap-2">
              <Input
                readOnly
                value={state.link}
                size="sm"
                aria-label="Invitation link"
                onFocus={(event) => event.currentTarget.select()}
                className="font-mono text-xs"
              />
              <CopyButton value={state.link} variant="secondary">
                Copy link
              </CopyButton>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
