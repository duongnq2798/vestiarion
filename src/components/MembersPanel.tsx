"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import {
  changeMemberRoleAction,
  inviteMemberAction,
  removeMemberAction,
  revokeInvitationAction,
  type MemberActionResult,
} from "@/app/actions/members";
import { Card, Label, SectionHead } from "@/components/vx/Primitives";
import { canAssignRole } from "@/lib/auth/roles";
import type { OrgRole } from "@/lib/auth/roles";
import type { Member, OpenInvitation } from "@/lib/platform/members";

const INITIAL: MemberActionResult = { ok: false, message: "" };

const dateFormat = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

function joined(iso: string): string {
  return dateFormat.format(new Date(iso));
}

function RoleCell({ orgSlug, member, canChange, assignable }: { orgSlug: string; member: Member; canChange: boolean; assignable: readonly OrgRole[] }) {
  const [state, action, pending] = useActionState(changeMemberRoleAction, INITIAL);

  if (!canChange) return <span className="capitalize text-ink">{member.role}</span>;

  return (
    <form action={action} className="inline-flex flex-col gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="userId" value={member.userId} />
      <select
        name="role"
        defaultValue={member.role}
        disabled={pending}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
        className="h-8 rounded-lg border border-line-strong bg-ground px-2 text-sm capitalize text-ink outline-none focus:border-agent focus:ring-2 focus:ring-agent-soft"
      >
        {assignable.map((role) => (
          <option key={role} value={role}>{role}</option>
        ))}
      </select>
      {!state.ok && state.message && <span className="text-xs text-refused">{state.message}</span>}
    </form>
  );
}

/** Removing someone else. The viewer's own row uses `LeaveCell` instead — see the note on that component. */
function RemoveButton({ orgSlug, member }: { orgSlug: string; member: Member }) {
  const [state, action, pending] = useActionState(removeMemberAction, INITIAL);

  return (
    <form action={action} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="userId" value={member.userId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-refused-line px-2.5 py-1 text-xs font-medium text-refused transition-colors hover:bg-refused-soft disabled:opacity-60"
      >
        {pending ? "Removing…" : "Remove"}
      </button>
      {!state.ok && state.message && <span className="text-xs text-refused">{state.message}</span>}
    </form>
  );
}

/**
 * The viewer's own row. Self-removal does not revalidate the route (see
 * `removeMemberAction`), specifically so this state and its redirect live in
 * `MembersPanel` — a component that is not part of whatever re-renders once
 * membership changes — rather than in a per-row component that a revalidation
 * could unmount before its effect runs.
 */
function LeaveCell({
  orgSlug,
  userId,
  action,
  state,
  pending,
}: {
  orgSlug: string;
  userId: string;
  action: (formData: FormData) => void;
  state: MemberActionResult;
  pending: boolean;
}) {
  return (
    <form action={action} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="userId" value={userId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-refused-line px-2.5 py-1 text-xs font-medium text-refused transition-colors hover:bg-refused-soft disabled:opacity-60"
      >
        {pending ? "Leaving…" : "Leave"}
      </button>
      {!state.ok && state.message && <span className="text-xs text-refused">{state.message}</span>}
    </form>
  );
}

function InviteForm({ orgSlug, assignable }: { orgSlug: string; assignable: readonly OrgRole[] }) {
  const [state, action, pending] = useActionState(inviteMemberAction, INITIAL);
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    if (!state.link) return;
    try {
      await navigator.clipboard.writeText(state.link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <form
      action={action}
      onSubmit={() => setCopied(false)}
      className="surface-shadow flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:p-5"
    >
      <input type="hidden" name="orgSlug" value={orgSlug} />
      {/* The fields share one row; the result sits below it, so the email field keeps the row's free width. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="invite-email" className="block text-sm font-medium text-ink">Email</label>
          <input
            id="invite-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="name@company.com"
            className="mt-1 h-10 w-full rounded-lg border border-line-strong bg-ground px-3 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-agent focus:ring-2 focus:ring-agent-soft"
          />
        </div>
        <div>
          <label htmlFor="invite-role" className="block text-sm font-medium text-ink">Role</label>
          <select
            id="invite-role"
            name="role"
            defaultValue={assignable[assignable.length - 1]}
            className="mt-1 h-10 w-full rounded-lg border border-line-strong bg-ground px-3 text-sm capitalize text-ink outline-none focus:border-agent focus:ring-2 focus:ring-agent-soft sm:w-auto"
          >
            {assignable.map((role) => (
              <option key={role} value={role}>{role}</option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="brand-shadow h-10 rounded-xl bg-agent px-4 text-sm font-semibold text-on-agent transition-transform hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-70"
        >
          {pending ? "Inviting…" : "Invite"}
        </button>
      </div>
      <div className="empty:hidden">
        {state.message && (
          <p aria-live="polite" className={`text-sm ${state.ok ? "text-ink-3" : "text-refused"}`}>{state.message}</p>
        )}
        {state.link && (
          <div className="mt-2 flex items-center gap-2">
            <input
              readOnly
              value={state.link}
              onFocus={(event) => event.currentTarget.select()}
              className="h-9 flex-1 rounded-lg border border-line-strong bg-ground px-3 font-mono text-xs text-ink-2"
            />
            <button
              type="button"
              onClick={copyLink}
              className="h-9 rounded-lg border border-line-strong px-3 text-xs font-medium text-ink-2 hover:bg-raised"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
      </div>
    </form>
  );
}

function InvitationRow({ orgSlug, invitation }: { orgSlug: string; invitation: OpenInvitation }) {
  const [state, action, pending] = useActionState(revokeInvitationAction, INITIAL);
  const revoked = state.ok;

  if (revoked) return null;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm text-ink">{invitation.email}</p>
        <p className="text-xs capitalize text-ink-3">{invitation.role} · expires {joined(invitation.expiresAt)}</p>
      </div>
      <form action={action} className="flex items-center gap-2">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="invitationId" value={invitation.id} />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-refused-line px-2.5 py-1 text-xs font-medium text-refused transition-colors hover:bg-refused-soft disabled:opacity-60"
        >
          {pending ? "Revoking…" : "Revoke"}
        </button>
      </form>
      {!state.ok && state.message && <span className="text-xs text-refused">{state.message}</span>}
    </li>
  );
}

export default function MembersPanel({
  orgSlug,
  members,
  invitations,
  viewerId,
  viewerRole,
  assignable,
}: {
  orgSlug: string;
  members: Member[];
  invitations: OpenInvitation[];
  viewerId: string;
  viewerRole: OrgRole;
  assignable: readonly OrgRole[];
}) {
  const isManager = assignable.length > 0;
  const router = useRouter();
  const [leaveState, leaveAction, leavePending] = useActionState(removeMemberAction, INITIAL);

  useEffect(() => {
    if (leaveState.left) router.replace("/onboarding");
  }, [leaveState.left, router]);

  return (
    <div className="space-y-8">
      <section>
        <SectionHead title="Members" meta={`${members.length} in this workspace`} />
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className="px-4 py-3"><Label>Email</Label></th>
                <th className="px-4 py-3"><Label>Role</Label></th>
                <th className="px-4 py-3"><Label>Joined</Label></th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {members.map((member) => {
                const isSelf = member.userId === viewerId;
                const canChange = !isSelf && canAssignRole(viewerRole, member.role);
                return (
                  <tr key={member.userId}>
                    <td className="max-w-[240px] truncate px-4 py-3 text-ink">{member.email}</td>
                    <td className="px-4 py-3">
                      <RoleCell orgSlug={orgSlug} member={member} canChange={canChange} assignable={assignable} />
                    </td>
                    <td className="px-4 py-3 text-ink-2">{joined(member.joinedAt)}</td>
                    <td className="px-4 py-3 text-right">
                      {isSelf ? (
                        <LeaveCell orgSlug={orgSlug} userId={member.userId} action={leaveAction} state={leaveState} pending={leavePending} />
                      ) : canChange ? (
                        <RemoveButton orgSlug={orgSlug} member={member} />
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </section>

      {isManager && (
        <>
          <section>
            <SectionHead title="Invite someone" meta="the link is shown once, right after sending" />
            <InviteForm orgSlug={orgSlug} assignable={assignable} />
          </section>

          <section>
            <SectionHead title="Open invitations" meta={`${invitations.length} pending`} />
            {invitations.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line-strong px-5 py-6 text-sm text-ink-2">No invitations are waiting on a reply.</p>
            ) : (
              <Card>
                <ul className="divide-y divide-line">
                  {invitations.map((invitation) => (
                    <InvitationRow key={invitation.id} orgSlug={orgSlug} invitation={invitation} />
                  ))}
                </ul>
              </Card>
            )}
          </section>
        </>
      )}
    </div>
  );
}
