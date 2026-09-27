import { viewerCanMutate } from "@/lib/auth/authorize";
import type { CycleClockMode } from "@/lib/clock";
import AgentControlsClient from "./AgentControlsClient";

/** Renders nothing for someone who may not run the agent — no locked button to tempt them. */
export default async function AgentControls({
  orgSlug,
  nextDay,
  headSeq,
  clockMode = "simulate",
}: {
  orgSlug: string;
  nextDay: number;
  headSeq?: number;
  clockMode?: CycleClockMode;
}) {
  if (!(await viewerCanMutate(orgSlug))) return null;
  return <AgentControlsClient orgSlug={orgSlug} nextDay={nextDay} headSeq={headSeq} clockMode={clockMode} />;
}
