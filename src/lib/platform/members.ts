import crypto from "node:crypto";
import { siteOrigin } from "../auth/env";
import type { OrgRole } from "../auth/roles";
import { currentOrgId } from "../context";
import { platformDb, unwrap } from "../dal";
import { invitationEmail } from "../email/invitation";
import { sendEmail } from "../email/send";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";

/**
 * Members and invitations (spec §7, §10 step 5b). Every change goes through a
 * service-role function (migration 0021) that is told who is acting and
 * checks that person's role itself; this module adds the signed ledger entry
 * and the email. The ledger records user ids, never an email address.
 *
 * The ledger entry is appended after the function has committed, in its own
 * transaction, so it is best effort: if it fails, the change it describes has
 * still happened, and is reported as done (see `appendLedgerEntryBestEffort`).
 */

export type MemberErrorCode =
  | "not_a_member" | "member_not_found" | "role_not_assignable" | "invalid_email" | "already_a_member"
  | "invitation_limit_reached" | "invitation_not_found" | "invitation_used" | "invitation_expired"
  | "invitation_email_mismatch" | "invitation_no_longer_valid" | "invitation_rate_limited" | "last_owner";

const MESSAGES: Record<MemberErrorCode, string> = {
  not_a_member: "You are not a member of this workspace.",
  member_not_found: "That person is not a member of this workspace.",
  role_not_assignable: "Your role cannot grant or change that role.",
  invalid_email: "That does not look like an email address.",
  already_a_member: "That person is already a member of this workspace.",
  invitation_limit_reached: "This workspace already has 20 open invitations. Revoke one first.",
  invitation_not_found: "This invitation link is not valid.",
  invitation_used: "This invitation has already been accepted.",
  invitation_expired: "This invitation has expired. Ask for a new one.",
  invitation_email_mismatch: "This invitation was sent to a different email address. Sign in with that address to accept it.",
  invitation_no_longer_valid: "The person who sent this invitation can no longer grant that role. Ask for a new one.",
  invitation_rate_limited: "This workspace has sent 50 invitations in the last 24 hours. Try again tomorrow.",
  last_owner: "A workspace must keep at least one owner.",
};

export class MemberError extends Error {
  constructor(readonly code: MemberErrorCode) {
    super(MESSAGES[code]);
    this.name = "MemberError";
  }
}

export function memberErrorFrom(error: { message: string }): MemberError | null {
  if (/last owner/.test(error.message)) return new MemberError("last_owner");
  const code = /^([a-z_]+):/.exec(error.message)?.[1];
  return code && code in MESSAGES ? new MemberError(code as MemberErrorCode) : null;
}

function raise(error: { message: string }): never {
  throw memberErrorFrom(error) ?? new Error(error.message);
}

export function hashInvitationToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** The row `invite_member` returns — `public.invitations` (migration 0021). */
interface InvitationRow {
  id: string;
  org_id: string;
  email: string;
  role: OrgRole;
  token_hash: string;
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface Member {
  userId: string;
  email: string;
  role: OrgRole;
  joinedAt: string;
}

export interface OpenInvitation {
  id: string;
  email: string;
  role: OrgRole;
  expiresAt: string;
}

/**
 * Invites someone into the organization in scope. Runs inside an
 * organization scope (`withOrg`), which is where `p_org_id` and the ledger
 * entry's key material come from.
 */
export async function inviteMember(input: {
  actorId: string;
  orgName: string;
  email: string;
  role: OrgRole;
  token?: string;
}): Promise<{ invitationId: string; link: string; emailed: boolean }> {
  const orgId = currentOrgId();
  const token = input.token ?? crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashInvitationToken(token);

  const result = await platformDb()
    .rpc("invite_member", {
      p_org_id: orgId,
      p_actor: input.actorId,
      p_email: input.email,
      p_role: input.role,
      p_token_hash: tokenHash,
    })
    .single<InvitationRow>();
  if (result.error) raise(result.error);
  const row = result.data as InvitationRow;

  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "system",
    action: "member_invited",
    summary: `Invitation sent for the ${input.role} role`,
    detail: { by: input.actorId, invitationId: row.id, role: input.role },
  });

  const link = `${siteOrigin()}/invite/${token}`;
  const email = invitationEmail({
    orgName: input.orgName,
    role: input.role,
    link,
    expiresAt: new Date(row.expires_at),
    origin: siteOrigin(),
  });
  const sendResult = await sendEmail({ to: row.email, subject: email.subject, html: email.html, text: email.text });
  if (!sendResult.sent) {
    // Never the address or the link — only the reason the send did not happen.
    console.warn(`invitation email not sent: ${sendResult.reason}`);
  }

  return { invitationId: row.id, link, emailed: sendResult.sent };
}

/** The row `accept_invitation` and `accept_invitation_by_id` both return. */
interface AcceptedInvitationRow {
  org_id: string;
  slug: string;
  role: OrgRole;
  invitation_id: string;
}

/**
 * The ledger entry and return shape both acceptance paths share, once the
 * RPC (whichever one) has named the organization and the row. Runs outside
 * any scope until here: the organization is not known before the RPC
 * returns, after which the ledger entry is appended inside its own scope.
 */
async function finishAcceptance(row: AcceptedInvitationRow, userId: string): Promise<{ orgId: string; slug: string; role: OrgRole }> {
  await appendLedgerEntryBestEffort(
    row.org_id,
    {
      actor: "human",
      domain: "system",
      action: "member_joined",
      summary: `A member joined with the ${row.role} role`,
      detail: { by: userId, role: row.role, invitationId: row.invitation_id },
    },
    { enterScope: { userId } }
  );

  return { orgId: row.org_id, slug: row.slug, role: row.role };
}

/** Accepts an invitation by its token, for the signed-in user. */
export async function acceptInvitation(input: { token: string; userId: string }): Promise<{ orgId: string; slug: string; role: OrgRole }> {
  const result = await platformDb()
    .rpc("accept_invitation", { p_token_hash: hashInvitationToken(input.token), p_user_id: input.userId })
    .single<AcceptedInvitationRow>();
  if (result.error) raise(result.error);
  return finishAcceptance(result.data as AcceptedInvitationRow, input.userId);
}

/**
 * Accepts an invitation by its id, for the signed-in user — for the pending
 * invitations listed on /onboarding (migration 0024), where the id is what
 * the page already has rather than the raw token from a link.
 */
export async function acceptInvitationById(input: { invitationId: string; userId: string }): Promise<{ orgId: string; slug: string; role: OrgRole }> {
  const result = await platformDb()
    .rpc("accept_invitation_by_id", { p_invitation_id: input.invitationId, p_user_id: input.userId })
    .single<AcceptedInvitationRow>();
  if (result.error) raise(result.error);
  return finishAcceptance(result.data as AcceptedInvitationRow, input.userId);
}

export interface PendingInvitation {
  invitationId: string;
  orgName: string;
  role: OrgRole;
  expiresAt: string;
}

/** The open invitations waiting for the signed-in user, across every organization (migration 0024). */
export async function pendingInvitationsFor(userId: string): Promise<PendingInvitation[]> {
  const rows = unwrap(await platformDb().rpc("pending_invitations_for", { p_user_id: userId })) as Array<{
    invitation_id: string;
    org_name: string;
    role: OrgRole;
    expires_at: string;
  }>;
  return rows.map((row) => ({ invitationId: row.invitation_id, orgName: row.org_name, role: row.role, expiresAt: row.expires_at }));
}

/** For the accept page: what an invitation link is for, before the person signs in. */
export async function invitationPreview(token: string): Promise<{ orgName: string; role: OrgRole; state: "open" | "used" | "expired" } | null> {
  const result = await platformDb()
    .from("invitations")
    .select("role, expires_at, accepted_at, revoked_at, orgs!inner(name)")
    .eq("token_hash", hashInvitationToken(token))
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) return null;

  const row = result.data as unknown as {
    role: OrgRole;
    expires_at: string;
    accepted_at: string | null;
    revoked_at: string | null;
    orgs: { name: string };
  };
  // A withdrawn invitation reads as an unknown link, as accept_invitation treats it.
  if (row.revoked_at !== null) return null;
  const state: "open" | "used" | "expired" =
    row.accepted_at !== null ? "used" : new Date(row.expires_at) <= new Date() ? "expired" : "open";
  return { orgName: row.orgs.name, role: row.role, state };
}

/** Runs in scope: `p_org_id` comes from `currentOrgId()`. */
export async function changeMemberRole(input: { actorId: string; userId: string; role: OrgRole }): Promise<void> {
  const orgId = currentOrgId();
  const result = await platformDb()
    .rpc("change_member_role", { p_org_id: orgId, p_actor: input.actorId, p_user_id: input.userId, p_role: input.role })
    .single<OrgRole>();
  if (result.error) raise(result.error);
  const from = result.data as OrgRole;

  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "system",
    action: "member_role_changed",
    summary: `A member's role changed from ${from} to ${input.role}`,
    detail: { by: input.actorId, member: input.userId, from, to: input.role },
  });
}

/** Runs in scope: `p_org_id` comes from `currentOrgId()`. */
export async function removeMember(input: { actorId: string; userId: string }): Promise<void> {
  const orgId = currentOrgId();
  const result = await platformDb()
    .rpc("remove_member", { p_org_id: orgId, p_actor: input.actorId, p_user_id: input.userId })
    .single<OrgRole>();
  if (result.error) raise(result.error);
  const role = result.data as OrgRole;

  if (input.actorId === input.userId) {
    await appendLedgerEntryBestEffort(orgId, {
      actor: "human",
      domain: "system",
      action: "member_left",
      summary: `A member with the ${role} role left the workspace`,
      detail: { by: input.actorId, role },
    });
  } else {
    await appendLedgerEntryBestEffort(orgId, {
      actor: "human",
      domain: "system",
      action: "member_removed",
      summary: `A member with the ${role} role was removed`,
      detail: { by: input.actorId, member: input.userId, role },
    });
  }
}

/** Runs in scope: `p_org_id` comes from `currentOrgId()`. */
export async function revokeInvitation(input: { actorId: string; invitationId: string }): Promise<void> {
  const orgId = currentOrgId();
  const result = await platformDb().rpc("revoke_invitation", {
    p_org_id: orgId,
    p_actor: input.actorId,
    p_invitation_id: input.invitationId,
  });
  if (result.error) raise(result.error);

  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "system",
    action: "invitation_revoked",
    summary: "An invitation was revoked",
    detail: { by: input.actorId, invitationId: input.invitationId },
  });
}

export async function listMembers(orgId: string): Promise<Member[]> {
  const rows = unwrap(await platformDb().rpc("org_members", { p_org_id: orgId })) as Array<{
    user_id: string;
    email: string;
    role: OrgRole;
    joined_at: string;
  }>;
  return rows.map((row) => ({ userId: row.user_id, email: row.email, role: row.role, joinedAt: row.joined_at }));
}

export async function listOpenInvitations(orgId: string): Promise<OpenInvitation[]> {
  const rows = unwrap(
    await platformDb()
      .from("invitations")
      .select("id, email, role, expires_at")
      .eq("org_id", orgId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at")
  ) as Array<{ id: string; email: string; role: OrgRole; expires_at: string }>;
  return rows.map((row) => ({ id: row.id, email: row.email, role: row.role, expiresAt: row.expires_at }));
}
