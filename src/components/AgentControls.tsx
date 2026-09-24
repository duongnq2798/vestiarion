import { hasAgentControlSession } from "@/lib/agent-session";
import AgentControlsClient from "./AgentControlsClient";
import AgentControlsUnlock from "./AgentControlsUnlock";

export default async function AgentControls({ nextDay, headSeq }: { nextDay: number; headSeq?: number }) {
  if (!(await hasAgentControlSession())) return <AgentControlsUnlock />;
  return <AgentControlsClient nextDay={nextDay} headSeq={headSeq} />;
}
