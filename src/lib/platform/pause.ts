import { platformDb } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import type { Provenance } from "../provenance";

/**
 * The pause switch (spec §D7): lets a member stop the workspace's agent, and
 * an owner or admin start it again. Every change goes through a service-role
 * function (migration 0025) that is told who is acting and checks that
 * person's role itself; this module adds the signed ledger entry, best effort,
 * through `appendLedgerEntryBestEffort` as `src/lib/platform/members.ts` does.
 *
 * Unlike the members functions, `pauseAgent` and `resumeAgent` are not called
 * from inside the organization's own scope: the RPCs run against
 * `platformDb()`, which needs none, and only the ledger entry does — so each
 * opens its own scope (`enterScope`) around just that append, the same shape
 * `finishAcceptance` in `members.ts` uses for `member_joined`.
 */

export type PauseErrorCode = "not_a_member" | "pause_not_permitted" | "resume_not_permitted" | "already_paused" | "not_paused";

const MESSAGES: Record<PauseErrorCode, string> = {
  not_a_member: "You are not a member of this workspace.",
  pause_not_permitted: "Your role cannot pause the agent.",
  resume_not_permitted: "Only an owner or admin can resume the agent.",
  already_paused: "The agent is already paused.",
  not_paused: "The agent is already running.",
};

export class PauseError extends Error {
  constructor(readonly code: PauseErrorCode) {
    super(MESSAGES[code]);
    this.name = "PauseError";
  }
}

function raise(error: { message: string }): never {
  const code = /^([a-z_]+):/.exec(error.message)?.[1];
  if (code && code in MESSAGES) throw new PauseError(code as PauseErrorCode);
  throw new Error(error.message);
}

/** Trimmed, capped at 280 characters, and `null` once empty — never an empty string, in the RPC argument or the ledger. */
function trimReason(reason: string | undefined): string | null {
  const trimmed = (reason ?? "").trim().slice(0, 280);
  return trimmed.length > 0 ? trimmed : null;
}

/** `provenance`, when given, names the surface the person acted from (integrations design R3); the console gives none. */
export async function pauseAgent(input: { orgId: string; actorId: string; reason?: string; provenance?: Provenance }): Promise<void> {
  const reason = trimReason(input.reason);
  const result = await platformDb()
    .rpc("pause_agent", { p_org_id: input.orgId, p_actor: input.actorId, p_reason: reason })
    .single();
  if (result.error) raise(result.error);

  await appendLedgerEntryBestEffort(
    input.orgId,
    {
      actor: "human",
      domain: "system",
      action: "agent_paused",
      summary: "The agent was paused",
      detail: { by: input.actorId, reason, ...input.provenance },
    },
    { enterScope: { userId: input.actorId } }
  );
}

/** `provenance`, when given, names the surface the person acted from (integrations design R3); the console gives none. */
export async function resumeAgent(input: { orgId: string; actorId: string; provenance?: Provenance }): Promise<void> {
  const result = await platformDb()
    .rpc("resume_agent", { p_org_id: input.orgId, p_actor: input.actorId })
    .single<string>();
  if (result.error) raise(result.error);
  const pausedSince = new Date(result.data as string).getTime();
  const pausedFor = Math.max(0, Math.round((Date.now() - pausedSince) / 1000));

  await appendLedgerEntryBestEffort(
    input.orgId,
    {
      actor: "human",
      domain: "system",
      action: "agent_resumed",
      summary: "The agent was resumed",
      detail: { by: input.actorId, pausedFor, ...input.provenance },
    },
    { enterScope: { userId: input.actorId } }
  );
}

export interface PauseState {
  pausedAt: string;
  pausedBy: string | null;
  reason: string | null;
}

/** `null` when the workspace's agent is not paused. */
export async function pauseStateOf(orgId: string): Promise<PauseState | null> {
  const result = await platformDb()
    .from("orgs")
    .select("agent_paused_at, agent_paused_by, agent_pause_reason")
    .eq("id", orgId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as { agent_paused_at: string | null; agent_paused_by: string | null; agent_pause_reason: string | null } | null;
  if (!row || row.agent_paused_at === null) return null;
  return { pausedAt: row.agent_paused_at, pausedBy: row.agent_paused_by, reason: row.agent_pause_reason };
}
