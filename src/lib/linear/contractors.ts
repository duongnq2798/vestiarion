import { connectionFor, NotSetUpError } from "../connectors/connections";
import { currentOrgId } from "../context";
import { listMembers } from "../platform/members";
import { LinearNotSetUpError, liveLinks, type IssueLink } from "./links";
import { linearSettingsFromEnv } from "./settings";

/**
 * What Contractors reads of Linear (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN16), in the
 * workspace's scope: whether Linear is connected, each milestone's linked issue, and the emails of whoever accepted one.
 * Null where Linear is not configured, before migration 0147, or when it cannot be read: the page then shows no Linear
 * controls, and everything else as before.
 */
export async function linearOnContractors(milestoneIds: readonly string[]): Promise<{
  connected: boolean;
  links: Map<string, IssueLink>;
  memberEmails: Record<string, string>;
} | null> {
  if (!linearSettingsFromEnv()) return null;
  try {
    const connection = await connectionFor("linear");
    const links = await liveLinks({ milestoneIds, limit: 1000 });
    const accepters = new Set(links.flatMap((link) => (link.acceptedBy ? [link.acceptedBy] : [])));
    const memberEmails =
      accepters.size > 0 ? Object.fromEntries((await listMembers(currentOrgId())).filter((member) => accepters.has(member.userId)).map((member) => [member.userId, member.email])) : {};
    return { connected: connection?.status === "connected", links: new Map(links.map((link) => [link.milestoneId, link])), memberEmails };
  } catch (error) {
    if (error instanceof NotSetUpError || error instanceof LinearNotSetUpError) return null;
    console.error("contractors: Linear not loaded", error instanceof Error ? error.message : error);
    return null;
  }
}
