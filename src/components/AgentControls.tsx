import { hasAgentControlSession } from "@/lib/agent-session";
import AgentControlsClient from "./AgentControlsClient";
import AgentControlsUnlock from "./AgentControlsUnlock";
import type { CycleClockMode } from "@/lib/clock";

export default async function AgentControls({ nextDay, headSeq, clockMode = "simulate" }: { nextDay: number; headSeq?: number; clockMode?: CycleClockMode }) {
  if (!(await hasAgentControlSession())) return <AgentControlsUnlock />;
  return <AgentControlsClient nextDay={nextDay} headSeq={headSeq} clockMode={clockMode} />;
}
