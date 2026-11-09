import { connectionFor, NotSetUpError } from "../connectors/connections";
import { currentOrgId } from "../context";
import { listMembers } from "../platform/members";
import { JiraNotSetUpError, liveLinks, type IssueLink } from "./links";
import { jiraSettingsFromEnv } from "./settings";

/**
 * What Contractors reads of Jira (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR1, JR22), as Linear's
 * (`../linear/contractors`), in the workspace's scope: whether Jira is connected, each milestone's linked issue, and the
 * emails of whoever accepted one. Null where Jira is not configured, before migration 0149, or when it cannot be read:
 * the page then shows no Jira controls, and everything else as before. Nothing here asks Jira: the card shows the issue
 * as last read.
 */
export async function jiraOnContractors(milestoneIds: readonly string[]): Promise<{
  connected: boolean;
  links: Map<string, IssueLink>;
  memberEmails: Record<string, string>;
} | null> {
  if (!jiraSettingsFromEnv()) return null;
  try {
    const connection = await connectionFor("jira");
    const links = await liveLinks({ milestoneIds, limit: 1000 });
    const accepters = new Set(links.flatMap((link) => (link.acceptedBy ? [link.acceptedBy] : [])));
    const memberEmails =
      accepters.size > 0 ? Object.fromEntries((await listMembers(currentOrgId())).filter((member) => accepters.has(member.userId)).map((member) => [member.userId, member.email])) : {};
    return { connected: connection?.status === "connected", links: new Map(links.map((link) => [link.milestoneId, link])), memberEmails };
  } catch (error) {
    if (error instanceof NotSetUpError || error instanceof JiraNotSetUpError) return null;
    console.error("contractors: Jira not loaded", error instanceof Error ? error.message : error);
    return null;
  }
}
