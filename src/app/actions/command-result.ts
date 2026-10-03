import "server-only";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import type { CommandOutcome } from "@/lib/commands/outcome";

/** The console's answer to a command (integrations design §9, Phase 0): its words, with its pages refreshed whenever anything changed. */
export function consoleAnswer(outcome: CommandOutcome): { ok: boolean; message: string } {
  if (outcome.ok || outcome.changed) revalidateOrgPages();
  return { ok: outcome.ok, message: outcome.message };
}
