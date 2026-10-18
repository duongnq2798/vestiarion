/**
 * Bring in a second person (docs/superpowers/specs/2026-10-19-invite-nudge-design.md I1-I6): when the console asks an
 * owner or admin who runs a workspace alone to invite an approver or an accountant, and how an invitation says it came
 * from that card or from the weekly brief. Pure, safe in client components.
 */

/** The cookie "Not now" sets on the workspace's own path, for 30 days (I2). */
export const INVITE_LATER_COOKIE = "vx_invite_later";
export const INVITE_LATER_DAYS = 30;

/** Where an invitation came from, recorded on `member_invited` (I5); an invitation from anywhere else has none. */
export const INVITE_VIA = ["console_nudge", "weekly_brief"] as const;
export type InviteVia = (typeof INVITE_VIA)[number];

export function isInviteVia(value: unknown): value is InviteVia {
  return typeof value === "string" && (INVITE_VIA as readonly string[]).includes(value);
}

/** Whether the console shows the card (I1, I6). */
export function inviteNudgeShown(input: {
  /** The viewer may invite (`members.manage`). */
  canManage: boolean;
  members: number;
  openInvitations: number;
  /** Real bills the agent has decided (`ownDecidedCount`). */
  decidedCount: number;
  /** "Not now" was chosen in this browser in the last 30 days. */
  putOff: boolean;
}): boolean {
  return input.canManage && input.members === 1 && input.openInvitations === 0 && input.decidedCount > 0 && !input.putOff;
}

/** Members, with the role the invitation form starts on and where the visit came from (I4, I5). */
export function inviteHref(slug: string, role: "approver" | "accountant", via: InviteVia): string {
  return `/o/${slug}/members?${new URLSearchParams({ invite: role, via }).toString()}`;
}

/** The cookie "Not now" writes: the workspace's own path, so each workspace keeps its own. */
export function inviteLaterCookie(slug: string, secure: boolean): string {
  return `${INVITE_LATER_COOKIE}=1; Max-Age=${INVITE_LATER_DAYS * 24 * 60 * 60}; Path=/o/${slug}; SameSite=Lax${secure ? "; Secure" : ""}`;
}
