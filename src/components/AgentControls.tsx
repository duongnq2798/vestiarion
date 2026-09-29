import type { ReactNode } from "react";
import { viewerCan } from "@/lib/auth/authorize";
import type { CycleClockMode } from "@/lib/clock";
import AgentControlsClient from "./AgentControlsClient";

/**
 * Renders no Run button for someone who may not run the agent — no locked
 * button to tempt them. `leading` (the treasury page's pause switch) sits
 * before Run in the same row, and still shows without Run: pausing is a
 * permission of its own.
 */
export default async function AgentControls({
  orgSlug,
  nextDay,
  headSeq,
  clockMode = "simulate",
  paused = false,
  leading,
}: {
  orgSlug: string;
  nextDay: number;
  headSeq?: number;
  clockMode?: CycleClockMode;
  /** A paused agent runs no cycle: the button stays, disabled, and says why. */
  paused?: boolean;
  leading?: ReactNode;
}) {
  if (!(await viewerCan(orgSlug, "agent.run_cycle"))) return leading ?? null;
  return <AgentControlsClient orgSlug={orgSlug} nextDay={nextDay} headSeq={headSeq} clockMode={clockMode} paused={paused} leading={leading} />;
}
