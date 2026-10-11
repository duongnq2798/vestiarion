import { CYCLE_IN_PROGRESS_MS } from "./agent/balances";
import { currentOrgId } from "./context";
import { db, unwrap, type OrgDb } from "./dal";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";
import { parseTwoApprovalsForm } from "./two-approvals";
import { workspaceNetwork } from "./workspace-network";
import { MAINNET_STARTING_TWO_APPROVALS } from "./mainnet";
import { sameFigure, type ReplaySummary } from "./policy-replay";

/**
 * The figure above which a payment needs two approvals (docs/superpowers/specs/2026-10-05-two-approvals-design.md T1):
 * one row per workspace in `approval_policies`, read by the agent once per cycle and by every approval. Every export
 * runs inside an organization scope; who may change it (`approval.policy`, owners) is the caller's check.
 *
 * Turning it on, or lowering it, needs two members who may approve payments, or nothing above it could ever be paid.
 * Raising it is always allowed, and so is turning it off, except on Arc mainnet, where a figure always stands
 * (mainnet limits L2). A change is refused while a cycle runs, as the agent's spending limit is: the cycle read the
 * figure when it began.
 *
 * Applied after trying it on past decisions (docs/superpowers/specs/2026-10-10-policy-replay-design.md P10), a change
 * carries the figure the replay ran against and is refused when it is no longer the one in force; its signed entry
 * records the replay's summary.
 */

export type ApprovalPolicyErrorCode = "invalid" | "unchanged" | "cycle_running" | "too_few_approvers" | "mainnet_keeps_figure" | "stale";

const MESSAGES: Record<Exclude<ApprovalPolicyErrorCode, "invalid" | "unchanged">, string> = {
  cycle_running: "A cycle is running. Try again in a minute, once it has finished.",
  too_few_approvers: "Two approvals need two people who can approve payments. Add an approver on Members first.",
  mainnet_keeps_figure: "A workspace on Arc mainnet keeps two approvals above a figure.",
  stale: "The figure for two approvals changed since you tried it. Try it again.",
};

export class ApprovalPolicyError extends Error {
  constructor(
    readonly code: ApprovalPolicyErrorCode,
    message: string = MESSAGES[code as Exclude<ApprovalPolicyErrorCode, "invalid" | "unchanged">]
  ) {
    super(message);
    this.name = "ApprovalPolicyError";
  }
}

const numeric = (value: string | number | null | undefined) => (value == null ? null : Number(value));

/**
 * The workspace's figure, or null when none is set or it is turned off. A figure that cannot be read, its table missing
 * included, throws: what reads it stops, rather than let one approval, or the agent, pay any amount.
 */
export async function readTwoApprovalsAbove(orgDb: OrgDb): Promise<number | null> {
  const result = await orgDb.from("approval_policies").select("two_approvals_above").limit(1);
  if (result.error) throw new Error(`approval_policies not read: ${result.error.message}`);
  const rows = (result.data ?? []) as Array<{ two_approvals_above: string | number | null }>;
  const stored = numeric(rows[0]?.two_approvals_above);
  // On Arc mainnet a figure always stands (mainnet limits L1, L2): a workspace whose row is missing, created before it
  // was written or left without it, reads the starting figure, never none (final review I1).
  if (stored === null && workspaceNetwork().id === "arc-mainnet") return MAINNET_STARTING_TWO_APPROVALS;
  return stored;
}

/** How many members may approve payments, leaving out those named (`approvers_besides`, migration 0076). */
export async function approversBesides(excluded: string[]): Promise<number> {
  const result = await db().rpc("approvers_besides", { p_org_id: currentOrgId(), p_excluded: excluded });
  if (result.error) throw new Error(result.error.message);
  if (typeof result.data !== "number") throw new Error("approvers_besides gave no count");
  return result.data;
}

/** What a change to the figure already in force is told. */
export function unchangedTwoApprovalsMessage(to: number | null): string {
  return to === null ? "Two approvals are already off." : `Payments above ${to} USDC already need two approvals.`;
}

function summary(from: number | null, to: number | null): string {
  if (to === null) return `Turned off two approvals above ${from} USDC`;
  if (from === null) return `Payments above ${to} USDC now need two approvals`;
  return to > from
    ? `Raised the figure for two approvals from ${from} USDC to ${to} USDC`
    : `Lowered the figure for two approvals from ${from} USDC to ${to} USDC`;
}

export async function changeTwoApprovals(input: {
  actorId: string;
  value: string;
  /** The figure a replay ran against; the change is refused when it is no longer the one in force. */
  expected?: number | null;
  /** The replay the change is applied after, for its signed entry. */
  replay?: ReplaySummary;
}): Promise<{ from: number | null; to: number | null }> {
  const parsed = parseTwoApprovalsForm(input.value);
  if (!parsed.ok) throw new ApprovalPolicyError("invalid", parsed.message);
  const to = parsed.above;
  // On Arc mainnet a person's payment above a figure always needs a second person (mainnet limits L2): raised, never off.
  if (to === null && workspaceNetwork().id === "arc-mainnet") throw new ApprovalPolicyError("mainnet_keeps_figure");

  const from = await readTwoApprovalsAbove(db());
  if (input.expected !== undefined && !sameFigure(from, input.expected)) throw new ApprovalPolicyError("stale");
  if (from === to) throw new ApprovalPolicyError("unchanged", unchangedTwoApprovalsMessage(to));

  const running = unwrap(
    await db()
      .from("cycle_runs")
      .select("id")
      .eq("status", "running")
      .gt("started_at", new Date(Date.now() - CYCLE_IN_PROGRESS_MS).toISOString())
      .limit(1)
  ) as Array<{ id: string }>;
  if (running.length > 0) throw new ApprovalPolicyError("cycle_running");

  // Tighter than before: more payments need two people, so there must be two who can give them.
  const tighter = to !== null && (from === null || to < from);
  if (tighter && (await approversBesides([])) < 2) throw new ApprovalPolicyError("too_few_approvers");

  // A write that asks for nothing back: only its error says whether it happened.
  const write = await db()
    .from("approval_policies")
    .upsert({ two_approvals_above: to, updated_by: input.actorId, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
  if (write.error) throw new Error(write.error.message);

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "system",
    action: "approval_policy_changed",
    summary: summary(from, to),
    detail: { by: input.actorId, from, to, ...(input.replay ? { replay: input.replay } : {}) },
  });

  return { from, to };
}

/** The figure and how many people can approve payments, for Settings. */
export async function twoApprovalsStatus(): Promise<{ above: number | null; approvers: number }> {
  const [above, approvers] = await Promise.all([readTwoApprovalsAbove(db()), approversBesides([])]);
  return { above, approvers };
}
