import { CYCLE_IN_PROGRESS_MS } from "./agent/balances";
import { currentOrgId } from "./context";
import { db, unwrap, type OrgDb } from "./dal";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";
import { parseTwoApprovalsForm } from "./two-approvals";

/**
 * The figure above which a payment needs two approvals (docs/superpowers/specs/2026-10-05-two-approvals-design.md T1):
 * one row per workspace in `approval_policies`, read by the agent once per cycle and by every approval. Every export
 * runs inside an organization scope; who may change it (`approval.policy`, owners) is the caller's check.
 *
 * Turning it on, or lowering it, needs two members who may approve payments, or nothing above it could ever be paid.
 * Raising it or turning it off is always allowed. A change is refused while a cycle runs, as the agent's spending limit
 * is: the cycle read the figure when it began.
 */

export type ApprovalPolicyErrorCode = "invalid" | "unchanged" | "cycle_running" | "too_few_approvers";

const MESSAGES: Record<Exclude<ApprovalPolicyErrorCode, "invalid" | "unchanged">, string> = {
  cycle_running: "A cycle is running. Try again in a minute, once it has finished.",
  too_few_approvers: "Two approvals need two people who can approve payments. Add an approver on Members first.",
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

/** The workspace's figure, or null when none is set or it is turned off. */
export async function readTwoApprovalsAbove(orgDb: OrgDb): Promise<number | null> {
  const rows = unwrap(await orgDb.from("approval_policies").select("two_approvals_above").limit(1)) as Array<{
    two_approvals_above: string | number | null;
  }>;
  return numeric(rows[0]?.two_approvals_above);
}

/** How many members may approve payments, leaving out those named (`approvers_besides`, migration 0076). */
export async function approversBesides(excluded: string[]): Promise<number> {
  const result = await db().rpc("approvers_besides", { p_org_id: currentOrgId(), p_excluded: excluded });
  if (result.error) throw new Error(result.error.message);
  return Number(result.data ?? 0);
}

function summary(from: number | null, to: number | null): string {
  if (to === null) return `Turned off two approvals above ${from} USDC`;
  if (from === null) return `Payments above ${to} USDC now need two approvals`;
  return to > from
    ? `Raised the figure for two approvals from ${from} USDC to ${to} USDC`
    : `Lowered the figure for two approvals from ${from} USDC to ${to} USDC`;
}

export async function changeTwoApprovals(input: { actorId: string; value: string }): Promise<{ from: number | null; to: number | null }> {
  const parsed = parseTwoApprovalsForm(input.value);
  if (!parsed.ok) throw new ApprovalPolicyError("invalid", parsed.message);
  const to = parsed.above;

  const from = await readTwoApprovalsAbove(db());
  if (from === to) {
    throw new ApprovalPolicyError("unchanged", to === null ? "Two approvals are already off." : `Payments above ${to} USDC already need two approvals.`);
  }

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
    detail: { by: input.actorId, from, to },
  });

  return { from, to };
}

/** The figure and how many people can approve payments, for Settings. */
export async function twoApprovalsStatus(): Promise<{ above: number | null; approvers: number }> {
  const [above, approvers] = await Promise.all([readTwoApprovalsAbove(db()), approversBesides([])]);
  return { above, approvers };
}
