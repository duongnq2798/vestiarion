import { Callout } from "@/components/ui/Callout";
import { utcMinute } from "@/lib/copy";
import type { Member } from "@/lib/platform/members";
import type { PauseState } from "@/lib/platform/pause";

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
