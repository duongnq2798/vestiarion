"use client";

import { AnimatePresence, m } from "motion/react";
import { LogOut, MailCheck, Send, UserMinus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { flushSync } from "react-dom";
import {
  changeMemberRoleAction,
  inviteMemberAction,
  removeMemberAction,
  revokeInvitationAction,
  type MemberActionResult,
} from "@/app/actions/members";
import { setNotifyEmailAction, type NotifyEmailActionResult } from "@/app/actions/notifications";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { toast } from "@/components/ui/Toaster";
import { MOTION } from "@/components/ui/tokens";
import { useActionForm } from "@/components/ui/useActionForm";
import { TelegramCard } from "@/components/TelegramCard";
import { canAssignRole, type OrgRole } from "@/lib/auth/roles";
import { leaveWorkspaceDescription, removeMemberDescription } from "@/lib/member-keys";
import type { Member, OpenInvitation } from "@/lib/platform/members";

const INITIAL: MemberActionResult = { ok: false, message: "" };
const NOTIFY_INITIAL: NotifyEmailActionResult = { ok: false, message: "" };
const EXIT = { duration: MOTION.duration.exit, ease: MOTION.ease.exit };

const dateFormat = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

function joined(iso: string): string {
  return dateFormat.format(new Date(iso));
}

function RowError({ state }: { state: MemberActionResult }) {
  if (state.ok || !state.message) return null;
  return (
    <p role="alert" className="text-xs text-refused">
      {state.message}
    </p>
  );
}

/**
 * The viewer's own switch for the waiting-decision digest, above the table
 * (spec N6). It saves itself when changed, the same way `RoleCell` does:
 * the checkbox shows the requested state while the change is on its way,
 * and the server's answer afterwards — reverted to `initial` on a refusal.
 */
function NotifyEmailSwitch({ orgSlug, initial }: { orgSlug: string; initial: boolean }) {
  const [requested, setRequested] = useState(initial);
  const { state, pending, formProps } = useActionForm(setNotifyEmailAction, NOTIFY_INITIAL, { toastOnSuccess: true });

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
        <RowError state={state} />
      </form>
    </Card>
  );
}

/**
 * A role that saves itself when changed. While the change is on its way the
 * select shows the new role; afterwards it shows the server's answer — the
 * new role once saved, the old one if the change was refused.
 */
function RoleCell({ orgSlug, member, assignable }: { orgSlug: string; member: Member; assignable: readonly OrgRole[] }) {
  const [requested, setRequested] = useState<string>(member.role);
  const { state, pending, formProps } = useActionForm(changeMemberRoleAction, INITIAL, { toastOnSuccess: true });

  return (
    <form {...formProps} className="inline-flex flex-col gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="userId" value={member.userId} />
      <input type="hidden" name="role" value={requested} />
      <Select
        value={pending ? requested : member.role}
        disabled={pending}
        onValueChange={(role) => {
          // The hidden input must hold the new role before the form reads it.
          flushSync(() => setRequested(role));
          formProps.ref.current?.requestSubmit();
        }}
      >
        <SelectTrigger size="sm" aria-label={`Role of ${member.email}`} className="w-32 capitalize">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {assignable.map((role) => (
            <SelectItem key={role} value={role} className="capitalize">
              {role}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <RowError state={state} />
    </form>
  );
}

/**
 * Removing someone else. The viewer's own row uses `LeaveWorkspace` instead — see the note on that component.
 * `keyNames` are the API keys the member created here, which stop working with their membership (migration 0069).
 */
function RemoveMember({ orgSlug, member, keyNames }: { orgSlug: string; member: Member; keyNames: string[] }) {
  const formId = `remove-${member.userId}`;
  const { state, pending, formProps } = useActionForm(removeMemberAction, INITIAL, { toastOnSuccess: true });

  return (
    <form id={formId} {...formProps} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="userId" value={member.userId} />
      <ConfirmDialog
        formId={formId}
        trigger={
          <Button variant="danger" size="sm" icon={<UserMinus />} loading={pending}>
            Remove
          </Button>
        }
        title={`Remove ${member.email}?`}
        description={removeMemberDescription(keyNames)}
        confirmLabel="Remove member"
      />
      <RowError state={state} />
    </form>
  );
}

type LeaveForm = ReturnType<typeof useActionForm<MemberActionResult>>;

/**
 * The viewer's own row. Self-removal does not revalidate the route (see
 * `removeMemberAction`), specifically so the form's state and its redirect
 * live in `MembersPanel` — a component that is not part of whatever
 * re-renders once membership changes — rather than in a per-row component
 * that a revalidation could unmount first.
 */
function LeaveWorkspace({ orgSlug, userId, form, keyNames }: { orgSlug: string; userId: string; form: LeaveForm; keyNames: string[] }) {
  const formId = "leave-workspace";
  return (
    <form id={formId} {...form.formProps} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="userId" value={userId} />
      <ConfirmDialog
        formId={formId}
        trigger={
          <Button variant="danger" size="sm" icon={<LogOut />} loading={form.pending}>
            Leave
          </Button>
        }
        title="Leave this workspace?"
        description={leaveWorkspaceDescription(keyNames)}
        confirmLabel="Leave workspace"
      />
      <RowError state={form.state} />
    </form>
  );
}

function InviteForm({ orgSlug, assignable }: { orgSlug: string; assignable: readonly OrgRole[] }) {
  const { state, formProps } = useActionForm(inviteMemberAction, INITIAL, {
    resetOnSuccess: true,
    // With a link to hand over, the full message sits beside the link; the toast only confirms.
    onSuccess: (result) => toast.success(result.link ? "Invitation created" : result.message),
  });

  return (
    <Card asChild className="space-y-3 p-4 sm:p-5">
      <form {...formProps}>
        <input type="hidden" name="orgSlug" value={orgSlug} />
        {/* The fields share one row; the result sits below it, so the email field keeps the row's free width. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field id="invite-email" label="Email" className="min-w-0 flex-1">
            <Input name="email" type="email" required autoComplete="email" placeholder="name@company.com" />
          </Field>
          <Field id="invite-role" label="Role" className="sm:w-40">
            <Select name="role" defaultValue={assignable[assignable.length - 1]}>
              <SelectTrigger className="capitalize">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {assignable.map((role) => (
                  <SelectItem key={role} value={role} className="capitalize">
                    {role}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <SubmitButton icon={<Send />} pendingLabel="Inviting…" className="shrink-0">
            Invite
          </SubmitButton>
        </div>
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
        {state.ok && state.link && (
          <div className="rounded-xl border border-agent-line bg-agent-soft p-3">
            <p className="text-xs font-medium text-agent">{state.message}</p>
            <div className="mt-2 flex items-center gap-2">
              <Input readOnly value={state.link} size="sm" aria-label="Invitation link" onFocus={(event) => event.currentTarget.select()} className="font-mono text-xs" />
              <CopyButton value={state.link} variant="secondary">
                Copy link
              </CopyButton>
            </div>
          </div>
        )}
      </form>
    </Card>
  );
}

function InvitationRow({ orgSlug, invitation, onRevoked }: { orgSlug: string; invitation: OpenInvitation; onRevoked: () => void }) {
  const formId = `revoke-${invitation.id}`;
  const { state, pending, formProps } = useActionForm(revokeInvitationAction, INITIAL, { toastOnSuccess: true, onSuccess: onRevoked });

  return (
    <form id={formId} {...formProps} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="invitationId" value={invitation.id} />
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={invitation.email} tone="agent" size="sm" />
        <div className="min-w-0">
          <p className="truncate text-sm text-ink">{invitation.email}</p>
          <p className="text-xs capitalize text-ink-3">
            {invitation.role} · expires {joined(invitation.expiresAt)}
          </p>
        </div>
      </div>
      <ConfirmDialog
        formId={formId}
        trigger={
          <Button variant="danger" size="sm" icon={<X />} loading={pending}>
            Revoke
          </Button>
        }
        title={`Revoke the invitation for ${invitation.email}?`}
        description="The link stops working at once. You can send a new invitation later."
        confirmLabel="Revoke invitation"
      />
      <div className="w-full empty:hidden">
        <RowError state={state} />
      </div>
    </form>
  );
}

function OpenInvitations({ orgSlug, invitations }: { orgSlug: string; invitations: OpenInvitation[] }) {
  const [revoked, setRevoked] = useState<string[]>([]);
  const shown = invitations.filter((invitation) => !revoked.includes(invitation.id));

  return (
    <section aria-labelledby="open-invitations-title">
      <SectionHeader id="open-invitations-title" title="Open invitations" meta={`${shown.length} pending`} />
      {shown.length === 0 ? (
        <EmptyState compact icon={<MailCheck />} title="No invitations are waiting on a reply." />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            <AnimatePresence initial={false}>
              {shown.map((invitation) => (
                <m.li key={invitation.id} layout exit={{ opacity: 0, x: -12 }} transition={EXIT}>
                  <InvitationRow orgSlug={orgSlug} invitation={invitation} onRevoked={() => setRevoked((list) => [...list, invitation.id])} />
                </m.li>
              ))}
            </AnimatePresence>
          </ul>
        </Card>
      )}
    </section>
  );
}

export default function MembersPanel({
  orgSlug,
  members,
  invitations,
  viewerId,
  viewerRole,
  assignable,
  canDecide,
  notifyEmail,
  telegram = null,
  keyNames = {},
}: {
  orgSlug: string;
  members: Member[];
  invitations: OpenInvitation[];
  viewerId: string;
  viewerRole: OrgRole;
  assignable: readonly OrgRole[];
  /** Whether the viewer can decide payments — a viewer sees no switch, because they receive nothing. */
  canDecide: boolean;
  notifyEmail: boolean;
  /** The viewer's own Telegram chat for this workspace; null when this deployment has no bot (Telegram bot design R1). */
  telegram?: { link: { username: string | null; linkedAt: string } | null } | null;
  /** The names of the active API keys each member created, by user id: the viewer's own and those of members they may remove. */
  keyNames?: Record<string, string[]>;
}) {
  const isManager = assignable.length > 0;
  const router = useRouter();
  const leave = useActionForm(removeMemberAction, INITIAL, {
    onSuccess: (result) => {
      if (result.left) router.replace("/onboarding");
    },
  });

  return (
    <div className="space-y-8">
      {canDecide && <NotifyEmailSwitch orgSlug={orgSlug} initial={notifyEmail} />}
      {telegram && <TelegramCard orgSlug={orgSlug} link={telegram.link} />}
      <section aria-labelledby="members-title">
        <SectionHeader id="members-title" title="Members" meta={`${members.length} in this workspace`} />
        <Card className="overflow-hidden">
          <Table className="min-w-[36rem]">
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnimatePresence initial={false}>
                {members.map((member) => {
                  const isSelf = member.userId === viewerId;
                  const canChange = !isSelf && canAssignRole(viewerRole, member.role);
                  return (
                    <m.tr key={member.userId} exit={{ opacity: 0 }} transition={EXIT}>
                      <TableCell className="max-w-[20rem]">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <Avatar name={member.email} size="sm" />
                          <span className="truncate">{member.email}</span>
                          {isSelf && (
                            <Badge size="sm" tone="agent">
                              You
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>{canChange ? <RoleCell orgSlug={orgSlug} member={member} assignable={assignable} /> : <span className="capitalize">{member.role}</span>}</TableCell>
                      <TableCell className="whitespace-nowrap text-ink-2">{joined(member.joinedAt)}</TableCell>
                      <TableCell className="text-right">
                        {isSelf ? (
                          <LeaveWorkspace orgSlug={orgSlug} userId={member.userId} form={leave} keyNames={keyNames[member.userId] ?? []} />
                        ) : canChange ? (
                          <RemoveMember orgSlug={orgSlug} member={member} keyNames={keyNames[member.userId] ?? []} />
                        ) : null}
                      </TableCell>
                    </m.tr>
                  );
                })}
              </AnimatePresence>
            </TableBody>
          </Table>
        </Card>
      </section>

      {isManager && (
        <>
          <section aria-labelledby="invite-title">
            <SectionHeader id="invite-title" title="Invite someone" meta="the link is shown once, right after sending" />
            <InviteForm orgSlug={orgSlug} assignable={assignable} />
          </section>
          <OpenInvitations orgSlug={orgSlug} invitations={invitations} />
        </>
      )}
    </div>
  );
}
