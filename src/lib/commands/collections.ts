import { dayWords } from "../customer-portal/model";
import { CollectionError, resolveCollectionTask, saveCollectionPolicy, type PolicyInput, type Resolved } from "../collection-context/write";
import type { Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * Collections that follow the customer's context (docs/superpowers/specs/2026-10-13-collections-context-design.md C4,
 * C6): a customer's rules saved as a new version, and a collection task resolved. Records on the receivables side, so
 * `records.write` (owners and admins), from the console only.
 */

/** What a resolution did, in the console's words. */
export function resolvedWords(resolved: Resolved): string {
  const name = resolved.customerName;
  const claim = resolved.reason === "claim_unverified" ? "The claim of payment is marked not received. " : "";
  switch (resolved.outcome) {
    case "approved":
      return `Approved reminder ${resolved.approvedNumber} to ${name}, ${resolved.approvedTone}. The agent sends it within a minute, if nothing changed since.`;
    case "held":
      return `${claim}Reminders to ${name} about this invoice wait until ${dayWords(resolved.holdUntil as string)}.`;
    case "no_reminder":
      return `Reminders to ${name} about this invoice are off.`;
    case "resumed":
      return `${claim || "The promise is closed. "}The agent's reminders to ${name} go again.`;
    default:
      return "Done.";
  }
}

export async function setCollectionPolicy(actor: Actor, input: PolicyInput): Promise<CommandOutcome<{ version: number }>> {
  const refusal = gate(actor, "collection_policy.set");
  if (refusal) return refusal;
  try {
    const { customerName, policy } = await saveCollectionPolicy({ ...input, actorId: actor.userId });
    return done(`Saved ${customerName}'s rules as version ${policy.version}. The agent follows them from its next cycle.`, { version: policy.version });
  } catch (error) {
    if (error instanceof CollectionError) return refused(error.code, error.message, error.code === "changed" ? { changed: true } : {});
    console.error("saving collection rules failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}

export async function resolveCollectionTaskCommand(
  actor: Actor,
  input: { taskId: string; outcome: string; holdUntil?: string | null; tone?: string | null }
): Promise<CommandOutcome<{ startsCycle: boolean }>> {
  const refusal = gate(actor, "collection_task.resolve");
  if (refusal) return refusal;
  try {
    const resolved = await resolveCollectionTask({ actorId: actor.userId, ...input });
    return done(resolvedWords(resolved), { startsCycle: resolved.startsCycle });
  } catch (error) {
    if (error instanceof CollectionError) return refused(error.code, error.message, error.code === "changed" ? { changed: true } : {});
    console.error("resolving a collection task failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}
