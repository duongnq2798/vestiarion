import { viewerCan } from "@/lib/auth/authorize";
import type { CycleClockMode } from "@/lib/clock";
import AgentControlsClient from "./AgentControlsClient";

/** Renders nothing for someone who may not run the agent — no locked button to tempt them. */
export default async function AgentControls({
  orgSlug,
  nextDay,
  headSeq,
  clockMode = "simulate",
  paused = false,
}: {
  orgSlug: string;
  nextDay: number;
  headSeq?: number;
  clockMode?: CycleClockMode;
  /** A paused agent runs no cycle: the button stays, disabled, and says why. */
  paused?: boolean;
}) {
  if (!(await viewerCan(orgSlug, "agent.run_cycle"))) return null;
  return <AgentControlsClient orgSlug={orgSlug} nextDay={nextDay} headSeq={headSeq} clockMode={clockMode} paused={paused} />;
}
