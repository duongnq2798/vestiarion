import { CYCLE_IN_PROGRESS_MS } from "./agent/balances";
import { can, type OrgRole } from "./auth/roles";
import { currentOrgId } from "./context";
import { db, unwrap, type OrgDb } from "./dal";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";
import { parseTwoApprovalsForm } from "./two-approvals";
import { workspaceNetwork } from "./workspace-network";
import { MAINNET_STARTING_TWO_APPROVALS } from "./mainnet";
import { sameFigure, type ReplaySummary } from "./policy-replay";
import { PAYEE_LOCK_OFF, payeeLockColumnsMissing, payeeLockFromRow, type PayeeLock } from "./payee-lock";

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

export type ApprovalPolicyErrorCode = "invalid" | "unchanged" | "cycle_running" | "too_few_approvers" | "mainnet_keeps_figure" | "stale" | "cosign_unavailable";

const MESSAGES: Record<Exclude<ApprovalPolicyErrorCode, "invalid" | "unchanged">, string> = {
  cycle_running: "A cycle is running. Try again in a minute, once it has finished.",
  too_few_approvers: "Two approvals need two people who can approve payments. Add an approver on Members first.",
  mainnet_keeps_figure: "A workspace on Arc mainnet keeps two approvals above a figure.",
  stale: "The figure for two approvals changed since you tried it. Try it again.",
  cosign_unavailable: "Co-signing is not available in this workspace yet.",
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
  return figureOf(rows[0]?.two_approvals_above);
}

/** The figure a row holds. On Arc mainnet a figure always stands (mainnet limits L1, L2): a workspace whose row is
 * missing, created before it was written or left without it, reads the starting figure, never none (final review I1). */
function figureOf(value: string | number | null | undefined): number | null {
  const stored = numeric(value);
  if (stored === null && workspaceNetwork().id === "arc-mainnet") return MAINNET_STARTING_TWO_APPROVALS;
  return stored;
}

/**
 * The figure for two approvals and the payee lock together, in one read, for an agent stage that weighs both
 * (docs/superpowers/specs/2026-10-20-payee-lock-design.md PL5). Before migration 0135 the lock's columns are missing:
 * the figure is read alone and the lock is off. Any other failure throws, as the figure's own read does.
 */
export async function readPaymentPolicies(orgDb: OrgDb): Promise<{ twoApprovalsAbove: number | null; payeeLock: PayeeLock }> {
  const result = await orgDb.from("approval_policies").select("two_approvals_above, payee_lock, payee_lock_cooling_hours").limit(1);
  if (result.error && payeeLockColumnsMissing(result.error)) return { twoApprovalsAbove: await readTwoApprovalsAbove(orgDb), payeeLock: PAYEE_LOCK_OFF };
  if (result.error) throw new Error(`approval_policies not read: ${result.error.message}`);
  const row = ((result.data ?? []) as Array<{ two_approvals_above: string | number | null; payee_lock?: boolean | null; payee_lock_cooling_hours?: number | string | null }>)[0];
  return { twoApprovalsAbove: figureOf(row?.two_approvals_above), payeeLock: payeeLockFromRow(row) };
}

/** How many members may approve payments, leaving out those named (`approvers_besides`, migration 0076). */
export async function approversBesides(excluded: string[]): Promise<number> {
  const result = await db().rpc("approvers_besides", { p_org_id: currentOrgId(), p_excluded: excluded });
  if (result.error) throw new Error(result.error.message);
  if (typeof result.data !== "number") throw new Error("approvers_besides gave no count");
  return result.data;
}

/**
 * How many accountants co-sign besides those named (`cosigners_besides`, migration 0138; accountant co-sign CS5): 0 while
 * co-signing is off. A count that cannot be read, before 0138 included, is 0, so the workspace works as it did before
 * co-signing: no one more can approve, and whoever entered a bill gives no fewer of its approvals than before.
 */
export async function cosignersBesides(excluded: string[]): Promise<number> {
  const result = await db().rpc("cosigners_besides", { p_org_id: currentOrgId(), p_excluded: excluded });
  // Before 0138 the function is missing, which is no fault: nothing co-signs yet.
  if (result.error && result.error.code !== "PGRST202" && result.error.code !== "42883") console.error("cosigners_besides not read", result.error.message);
  return !result.error && typeof result.data === "number" ? result.data : 0;
}

/**
 * How many of a bill's two approvals people besides those named can give (CS5): each owner, admin and approver, and one
 * co-signing accountant at most, since a co-sign is never the approval that pays. With two accountants and no other
 * approver, a founder still gives the approval that pays (review 1).
 */
export async function billApproversBesides(excluded: string[]): Promise<number> {
  const [approvers, cosigners] = await Promise.all([approversBesides(excluded), cosignersBesides(excluded)]);
  return approvers + Math.min(1, cosigners);
}

/**
 * Whether the workspace's accountants co-sign (CS1), and whether the database has the setting at all (`ready`, migration
 * 0138). With no row, or before 0138, it reads off. Any other failure throws.
 */
export async function readAccountantCosign(orgDb: OrgDb): Promise<{ on: boolean; ready: boolean }> {
  const result = await orgDb.from("approval_policies").select("accountant_cosigns").limit(1);
  if (result.error) {
    if (payeeLockColumnsMissing(result.error)) return { on: false, ready: false };
    throw new Error(`approval_policies not read: ${result.error.message}`);
  }
  const row = ((result.data ?? []) as Array<{ accountant_cosigns: boolean | null }>)[0];
  return { on: row?.accountant_cosigns === true, ready: true };
}

/**
 * Whether this role co-signs in the workspace in scope now (CS2, CS6): an accountant, while co-signing is on. A setting
 * that cannot be read counts as off, so nothing more is allowed than before.
 */
export async function cosignsNow(role: OrgRole): Promise<boolean> {
  if (!can(role, "approval.cosign")) return false;
  try {
    return (await readAccountantCosign(db())).on;
  } catch (error) {
    console.error("accountant co-sign not read", error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Turns co-signing on or off (CS1): an owner's, as the figure is. Off is always allowed, since fewer people then stand
 * behind payments; on needs migration 0138. Signed as `accountant_cosign_changed`.
 */
export async function changeAccountantCosign(input: { actorId: string; on: boolean }): Promise<{ from: boolean; to: boolean }> {
  const current = await readAccountantCosign(db());
  if (!current.ready) throw new ApprovalPolicyError("cosign_unavailable");
  if (current.on === input.on) throw new ApprovalPolicyError("unchanged", input.on ? "Accountants already co-sign." : "Accountants already do not co-sign.");
  const write = await db()
    .from("approval_policies")
    .upsert({ accountant_cosigns: input.on, updated_by: input.actorId, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
  if (write.error) throw new Error(write.error.message);
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "system",
    action: "accountant_cosign_changed",
    summary: input.on
      ? "Accountants now co-sign payments above the figure for two approvals, and confirm changed addresses"
      : "Accountants no longer co-sign payments or confirm addresses",
    detail: { by: input.actorId, from: current.on, to: input.on },
  });
  return { from: current.on, to: input.on };
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

  // Tighter than before: more payments need two people, so there must be two who can give them. A co-signing accountant
  // is one of them for bills (accountant co-sign CS5).
  const tighter = to !== null && (from === null || to < from);
  if (tighter && (await billApproversBesides([])) < 2) throw new ApprovalPolicyError("too_few_approvers");

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

/**
 * The figure, how many people can give a bill's approvals (co-signing accountants among them), how many of those are
 * accountants, and the co-sign setting, for Settings.
 */
export async function twoApprovalsStatus(): Promise<{ above: number | null; approvers: number; cosigners: number; cosign: { on: boolean; ready: boolean } }> {
  const [above, approvers, cosign] = await Promise.all([readTwoApprovalsAbove(db()), approversBesides([]), readAccountantCosign(db())]);
  const cosigners = cosign.on ? await cosignersBesides([]) : 0;
  return { above, approvers: approvers + cosigners, cosigners, cosign };
}
