import { Callout } from "@/components/ui/Callout";
import { utcMinute } from "@/lib/copy";
import { listMembers, type Member } from "@/lib/platform/members";
import { pauseStateOf, type PauseState } from "@/lib/platform/pause";

/** Who paused the agent, by their address; a pauser who has since left the workspace is "a member". */
export function pausedBy(pause: PauseState, members: Member[]): string {
  return members.find((member) => member.userId === pause.pausedBy)?.email ?? "a member";
}

/**
 * What every workspace page says while the agent is paused: since when, by
 * whom and why. Read by the workspace layout from platform data — the pause
 * on the organization row and its member list — so it reads no tenant rows;
 * drawn under the page's header (workspace shell design S4).
 */
export function AgentPausedBanner({ pause, members }: { pause: PauseState; members: Member[] }) {
  const reason = pause.reason?.trim();
  const text = `The agent is paused since ${utcMinute(pause.pausedAt)} by ${pausedBy(pause, members)}${reason ? `: ${reason}` : "."}`;
  return (
    <Callout tone="held" title="Agent paused">
      {text}
    </Callout>
  );
}

/**
 * What the layout needs to draw the banner: the pause, and the members to
 * name its author from — best effort. A failed pause read shows no banner
 * rather than taking every workspace page down with it, and says so in
 * `unread` for the header (workspace shell design S5); a failed member read
 * names the pauser "a member".
 */
export async function readPause(orgId: string): Promise<{ paused: { pause: PauseState; members: Member[] } | null; unread: boolean }> {
  try {
    const pause = await pauseStateOf(orgId);
    if (!pause) return { paused: null, unread: false };
    const members = await listMembers(orgId).catch((error: unknown) => {
      console.error("paused banner: members not loaded", orgId, error);
      return [];
    });
    return { paused: { pause, members }, unread: false };
  } catch (error) {
    console.error("paused banner: pause state not loaded", orgId, error);
    return { paused: null, unread: true };
  }
}

/** The banner's half of `readPause`: the pause and its members, or null when there is none or it could not be read. */
export async function pausedBanner(orgId: string): Promise<{ pause: PauseState; members: Member[] } | null> {
  return (await readPause(orgId)).paused;
}
