import { Callout } from "@/components/ui/Callout";
import { utcMinute } from "@/lib/copy";
import { listMembers, type Member } from "@/lib/platform/members";
import { pauseStateOf, type PauseState } from "@/lib/platform/pause";

/**
 * What every workspace page says while the agent is paused: since when, by
 * whom and why. Drawn by the workspace layout from platform data — the pause
 * on the organization row and its member list — so it reads no tenant rows.
 * A pauser who has since left the workspace is named "a member".
 */
export function AgentPausedBanner({ pause, members }: { pause: PauseState; members: Member[] }) {
  const by = members.find((member) => member.userId === pause.pausedBy)?.email ?? "a member";
  const reason = pause.reason?.trim();
  const text = `The agent is paused since ${utcMinute(pause.pausedAt)} by ${by}${reason ? `: ${reason}` : "."}`;
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-5 sm:px-6 sm:pt-7 lg:px-8 lg:pt-8">
      <Callout tone="held" title="Agent paused">
        {text}
      </Callout>
    </div>
  );
}

/**
 * What the layout needs to draw the banner: the pause, and the members to
 * name its author from — best effort. A failed pause read shows no banner
 * rather than taking every workspace page down with it; a failed member read
 * names the pauser "a member".
 */
export async function pausedBanner(orgId: string): Promise<{ pause: PauseState; members: Member[] } | null> {
  try {
    const pause = await pauseStateOf(orgId);
    if (!pause) return null;
    const members = await listMembers(orgId).catch((error: unknown) => {
      console.error("paused banner: members not loaded", orgId, error);
      return [];
    });
    return { pause, members };
  } catch (error) {
    console.error("paused banner: pause state not loaded", orgId, error);
    return null;
  }
}
