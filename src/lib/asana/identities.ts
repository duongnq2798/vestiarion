import { db } from "../dal";
import { listMembers } from "../platform/members";
import { selfAcceptance, type Identities } from "./acceptance";
import { AsanaNotSetUpError, liveLinks, milestonesForAcceptance } from "./links";
import type { AsanaContext } from "./workspace";

/**
 * Who the payee is, in Vestiarion and in Asana, and who is acting
 * (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A9). The payee is known in Vestiarion by the
 * counterparty's notice email, and in Asana, where it has an account, by the Asana user with that email. The member is
 * known by their own email, and in Asana by the connection's own user when they connected it, else by their email. Each
 * Asana lookup is a read of one user's id; nothing is kept.
 */
export async function identitiesOf(member: { orgId: string; userId: string }, milestone: { contractorId: string }, ctx: AsanaContext | null): Promise<Identities> {
  const members = await listMembers(member.orgId);
  const memberEmail = members.find((row) => row.userId === member.userId)?.email ?? null;
  const payee = await db().from("counterparties").select("notice_email").eq("id", milestone.contractorId).maybeSingle<{ notice_email: string | null }>();
  if (payee.error) throw new Error(payee.error.message);
  const payeeEmail = payee.data?.notice_email ?? null;
  if (!ctx) return { memberEmail, payeeEmail, memberAsanaGid: null, payeeAsanaGid: null };
  const lookup = (email: string | null) => (email ? ctx.session.call((token) => ctx.provider.reader.userByEmail(token, email)) : Promise.resolve(null));
  const memberAsanaGid = ctx.connection.connectedBy === member.userId ? ctx.connection.externalOrgId : await lookup(memberEmail);
  const payeeAsanaGid = await lookup(payeeEmail);
  return { memberEmail, payeeEmail, memberAsanaGid, payeeAsanaGid };
}

/**
 * Pay now on a milestone whose work was accepted from Asana: is the person its payee (A9)? Only ever a reason to refuse,
 * read before anything about the payment; false when the milestone has no Asana link, or Asana is not set up. Asana
 * itself is not asked: a payout is never held up by Asana answering slowly.
 */
export async function paysOwnPayout(member: { orgId: string; userId: string }, milestoneId: string): Promise<boolean> {
  try {
    const link = (await liveLinks({ milestoneIds: [milestoneId] }))[0];
    if (!link) return false;
    const milestone = (await milestonesForAcceptance([milestoneId])).get(milestoneId);
    if (!milestone) return false;
    return selfAcceptance(await identitiesOf(member, milestone, null)) !== null;
  } catch (error) {
    if (error instanceof AsanaNotSetUpError) return false;
    throw error;
  }
}
