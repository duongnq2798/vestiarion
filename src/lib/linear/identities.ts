import { db } from "../dal";
import { listMembers } from "../platform/members";
import { selfAcceptance, type Identities } from "./acceptance";
import { LinearNotSetUpError, liveLinks, milestonesForAcceptance } from "./links";
import type { LinearContext } from "./workspace";

/**
 * Who the payee is, in Vestiarion and in Linear, and who is acting (docs/superpowers/specs/2026-10-31-linear-acceptance-
 * design.md LN9), as Asana's (A9). The payee is known in Vestiarion by the counterparty's notice email, and in Linear,
 * where it has an account, by the Linear user with that email anywhere in the Linear workspace, whoever is on the
 * issue. The member is known by their own email, and in Linear by the connection's own user when they connected it,
 * else by the Linear user with their email. One read of Linear at acceptance, of ids by email; no email is kept.
 */
export async function identitiesOf(member: { orgId: string; userId: string }, milestone: { contractorId: string }, ctx: LinearContext | null): Promise<Identities> {
  const members = await listMembers(member.orgId);
  const memberEmail = members.find((row) => row.userId === member.userId)?.email ?? null;
  const payee = await db().from("counterparties").select("notice_email").eq("id", milestone.contractorId).maybeSingle<{ notice_email: string | null }>();
  if (payee.error) throw new Error(payee.error.message);
  const payeeEmail = payee.data?.notice_email ?? null;
  const none: Identities = { memberEmail, payeeEmail, payeeLinearIds: [], memberLinearIds: [] };
  // Without a payee email there is no Linear account to compare with: Linear is not asked.
  if (!ctx || !payeeEmail) return none;
  const connected = ctx.connection.connectedBy === member.userId;
  const found = await ctx.session.call((token) => ctx.provider.reader.people(token, { viewer: connected, payeeEmail, memberEmail: connected ? null : memberEmail }));
  return { memberEmail, payeeEmail, payeeLinearIds: found.payee, memberLinearIds: connected && found.viewerId ? [found.viewerId] : found.member };
}

/**
 * Pay now on a milestone whose work was accepted from Linear: is the person its payee (LN9)? Only ever a reason to
 * refuse, read before anything about the payment; false when the milestone has no Linear link, or Linear is not set
 * up. Linear itself is not asked: a payout is never held up by Linear answering slowly, so this check is by email.
 */
export async function approvesOwnLinearPayout(member: { orgId: string; userId: string }, milestoneId: string): Promise<boolean> {
  try {
    const link = (await liveLinks({ milestoneIds: [milestoneId] }))[0];
    if (!link) return false;
    const milestone = (await milestonesForAcceptance([milestoneId])).get(milestoneId);
    if (!milestone) return false;
    return selfAcceptance(await identitiesOf(member, milestone, null)) !== null;
  } catch (error) {
    if (error instanceof LinearNotSetUpError) return false;
    throw error;
  }
}
