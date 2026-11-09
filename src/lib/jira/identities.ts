import { db } from "../dal";
import { listMembers } from "../platform/members";
import { selfAcceptance, type Identities } from "./acceptance";
import { JiraNotSetUpError, liveLinks, milestonesForAcceptance } from "./links";
import { siteRef } from "./sites";
import type { JiraContext } from "./workspace";

/**
 * Who the payee is, in Vestiarion and in Jira, and who is acting (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md
 * JR12), as Linear's (LN9). The payee is known in Vestiarion by the counterparty's notice email, and in Jira, where it has
 * an account, by the Atlassian accounts user search finds by that email on the connected site, whoever is on the issue.
 * The member is known by their own email, and in Jira by the connection's own account (`/myself`) when they connected
 * it, else by the account found by their email. One read of Jira at acceptance, of account ids by email; no email and no
 * account id is kept (JR19).
 */
export async function identitiesOf(
  member: { orgId: string; userId: string },
  milestone: { contractorId: string },
  ctx: Pick<JiraContext, "connection" | "provider" | "session" | "site"> | null
): Promise<Identities> {
  const members = await listMembers(member.orgId);
  const memberEmail = members.find((row) => row.userId === member.userId)?.email ?? null;
  const payee = await db().from("counterparties").select("notice_email").eq("id", milestone.contractorId).maybeSingle<{ notice_email: string | null }>();
  if (payee.error) throw new Error(payee.error.message);
  const payeeEmail = payee.data?.notice_email ?? null;
  const none: Identities = { memberEmail, payeeEmail, payeeJiraIds: [], memberJiraIds: [] };
  // Without a payee email there is no Atlassian account to compare with: Jira is not asked.
  if (!ctx || !ctx.site || !payeeEmail) return none;
  const site = siteRef(ctx.site);
  const connected = ctx.connection.connectedBy === member.userId;
  const found = await ctx.session.call((token) => ctx.provider.reader.people(token, site, { myself: connected, payeeEmail, memberEmail: connected ? null : memberEmail }));
  return { memberEmail, payeeEmail, payeeJiraIds: found.payee, memberJiraIds: connected && found.myselfId ? [found.myselfId] : found.member };
}

/**
 * Pay now on a milestone whose work was accepted from Jira: is the person its payee (JR12)? Only ever a reason to
 * refuse, read before anything about the payment; false when the milestone has no Jira link, or Jira is not set up. Jira
 * itself is not asked: a payout is never held up by Jira answering slowly, so this check is by email.
 */
export async function approvesOwnJiraPayout(member: { orgId: string; userId: string }, milestoneId: string): Promise<boolean> {
  try {
    const link = (await liveLinks({ milestoneIds: [milestoneId] }))[0];
    if (!link) return false;
    const milestone = (await milestonesForAcceptance([milestoneId])).get(milestoneId);
    if (!milestone) return false;
    return selfAcceptance(await identitiesOf(member, milestone, null)) !== null;
  } catch (error) {
    if (error instanceof JiraNotSetUpError) return false;
    throw error;
  }
}
