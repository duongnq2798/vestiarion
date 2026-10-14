import { connectionFor, NotSetUpError } from "../connectors/connections";
import { currentOrgId } from "../context";
import { listMembers } from "../platform/members";
import { AsanaNotSetUpError, liveLinks, type TaskLink } from "./links";
import { asanaSettingsFromEnv } from "./settings";

/**
 * What Contractors reads of Asana (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A16), in the
 * workspace's scope: whether Asana is connected, each milestone's linked task, and the emails of whoever accepted one.
 * Null where Asana is not configured, before migration 0115, or when it cannot be read: the page then shows no Asana
 * controls, and everything else as before.
 */
export async function asanaOnContractors(milestoneIds: readonly string[]): Promise<{
  connected: boolean;
  links: Map<string, TaskLink>;
  memberEmails: Record<string, string>;
} | null> {
  if (!asanaSettingsFromEnv()) return null;
  try {
    const connection = await connectionFor("asana");
    const links = await liveLinks({ milestoneIds, limit: 1000 });
    const accepters = new Set(links.flatMap((link) => (link.acceptedBy ? [link.acceptedBy] : [])));
    const memberEmails =
      accepters.size > 0 ? Object.fromEntries((await listMembers(currentOrgId())).filter((member) => accepters.has(member.userId)).map((member) => [member.userId, member.email])) : {};
    return { connected: connection?.status === "connected", links: new Map(links.map((link) => [link.milestoneId, link])), memberEmails };
  } catch (error) {
    if (error instanceof NotSetUpError || error instanceof AsanaNotSetUpError) return null;
    console.error("contractors: Asana not loaded", error instanceof Error ? error.message : error);
    return null;
  }
}
