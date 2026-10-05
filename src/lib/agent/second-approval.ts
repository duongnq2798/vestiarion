import { currentOrgId } from "../context";
import { sameAddress } from "../counterparty-address";
import { db, unwrap } from "../dal";
import { approversBesides, readTwoApprovalsAbove } from "../approval-policy";
import type { TwoApprovalsFacts } from "../two-approvals";

/**
 * The approvals people give a payment above the workspace's figure (docs/superpowers/specs/2026-10-05-two-approvals-design.md
 * T4–T6), kept in `payment_approvals` (migration 0076). Each is bound to the payment it approved: its amount, currency and
 * the payee's address then. One that no longer agrees with the payment, or whose giver may no longer approve payments,
 * counts for nothing. The approval that pays marks the open ones used; Reject, Return and Close delete them. Every export
 * runs inside an organization scope.
 */

export interface PaymentSource {
  type: "invoice" | "milestone";
  id: string;
}

/** What an approval approved: the payment as it stood. */
export interface ApprovedPayment {
  amount: number;
  currency: string;
  address: string | null;
}

export interface GivenApproval extends ApprovedPayment {
  id: string;
  by: string;
  at: string;
}

type ApprovalRow = { id: string; approved_by: string; approved_at: string; amount: string | number; currency: string; address: string | null };

const COLUMNS = "id, approved_by, approved_at, amount, currency, address";

function given(row: ApprovalRow): GivenApproval {
  return { id: row.id, by: row.approved_by, at: row.approved_at, amount: Number(row.amount), currency: row.currency, address: row.address };
}

/** A payment's open approvals, oldest first. */
export async function openApprovals(source: PaymentSource): Promise<GivenApproval[]> {
  const rows = unwrap(
    await db()
      .from("payment_approvals")
      .select(COLUMNS)
      .eq("source_type", source.type)
      .eq("source_id", source.id)
      .is("used_at", null)
      .order("approved_at", { ascending: true })
  ) as ApprovalRow[];
  return rows.map(given);
}

/** Whether an approval is of this payment as it stands (T4): the same amount, currency and address. */
export function approvalAgrees(approval: ApprovedPayment, payment: ApprovedPayment): boolean {
  return (
    Math.abs(approval.amount - payment.amount) < 0.0000005 &&
    approval.currency === payment.currency &&
    payment.address !== null &&
    sameAddress(approval.address, payment.address)
  );
}

/** Of the people named, those who may approve payments in the workspace now (`approvers_among`, migration 0076). */
async function approversAmong(users: string[]): Promise<Set<string>> {
  const result = await db().rpc("approvers_among", { p_org_id: currentOrgId(), p_users: users });
  if (result.error) throw new Error(result.error.message);
  return new Set((result.data as string[] | null) ?? []);
}

/** The open approvals that still count (T4): they agree with the payment, and their giver may still approve payments. */
export async function standingApprovals(source: PaymentSource, payment: ApprovedPayment): Promise<GivenApproval[]> {
  const agreeing = (await openApprovals(source)).filter((approval) => approvalAgrees(approval, payment));
  if (agreeing.length === 0) return [];
  const approvers = await approversAmong([...new Set(agreeing.map((approval) => approval.by))]);
  return agreeing.filter((approval) => approvers.has(approval.by));
}

/** Records this person's approval of the payment as it stands, replacing an earlier open one of theirs. */
export async function giveApproval(source: PaymentSource, by: string, payment: ApprovedPayment): Promise<GivenApproval> {
  const removed = await db()
    .from("payment_approvals")
    .delete()
    .eq("source_type", source.type)
    .eq("source_id", source.id)
    .eq("approved_by", by)
    .is("used_at", null);
  if (removed.error) throw new Error(removed.error.message);
  const inserted = await db()
    .from("payment_approvals")
    .insert({ source_type: source.type, source_id: source.id, approved_by: by, amount: payment.amount, currency: payment.currency, address: payment.address })
    .select(COLUMNS)
    .single();
  if (inserted.error) throw new Error(inserted.error.message);
  return given(inserted.data as ApprovalRow);
}

/** Marks a payment's open approvals used, once the approval that pays it has claimed it (T6). */
export async function markApprovalsUsed(source: PaymentSource): Promise<void> {
  const update = await db()
    .from("payment_approvals")
    .update({ used_at: new Date().toISOString() })
    .eq("source_type", source.type)
    .eq("source_id", source.id)
    .is("used_at", null);
  if (update.error) throw new Error(update.error.message);
}

/** Deletes a payment's open approvals: Reject, Return to agent and Close without paying end the decision they were for (T6). */
export async function clearApprovals(source: PaymentSource): Promise<void> {
  const removed = await db().from("payment_approvals").delete().eq("source_type", source.type).eq("source_id", source.id).is("used_at", null);
  if (removed.error) throw new Error(removed.error.message);
}

const MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const memberIds = (ids: Array<string | null | undefined>) => [...new Set(ids.filter((id): id is string => typeof id === "string" && MEMBER_ID.test(id)))];

/**
 * Whether this person may give one of a payment's two approvals (T5): anyone who may approve payments, except whoever
 * entered it and, for a first payment to an address, whoever gave the address, unless fewer than two others can. Whether
 * the person may approve payments at all is the command's gate.
 */
export async function mayGiveApproval(input: { actorId: string; excluded: Array<string | null | undefined> }): Promise<boolean> {
  // Members only: a first payment's address may have been given by the payee ("payee"), who is no one here.
  const excluded = memberIds(input.excluded);
  if (!excluded.includes(input.actorId)) return true;
  return (await approversBesides(excluded)) < 2;
}

/** A payment waiting for a person, as a page lists it, for `twoApprovalsFacts`. */
export interface WaitingPayment {
  id: string;
  payment: ApprovedPayment;
  /** What it is weighed at against the figure, in USDC; null when its value is not known (T2). */
  weighed: number | null;
  /** Whoever entered it, and whoever gave a first payment's address. */
  excluded: Array<string | null | undefined>;
  /** A transfer for it was already sent: approving it only records it, on one approval (T6). */
  sent: boolean;
}

/**
 * For the payments a page lists, those above the workspace's figure: the approvals given that still count, and whether
 * whoever is left out may give one (two approvals T8). A handful of reads for the whole page: the figure, then only
 * when one is above it, their open approvals, who of their givers may still approve, and the count for each set of
 * people left out.
 */
export async function twoApprovalsFacts(type: PaymentSource["type"], items: WaitingPayment[]): Promise<Map<string, TwoApprovalsFacts>> {
  const facts = new Map<string, TwoApprovalsFacts>();
  if (items.length === 0) return facts;
  const above = await readTwoApprovalsAbove(db());
  if (above === null) return facts;
  const needing = items.filter((item) => !item.sent && (item.weighed === null || item.weighed > above));
  if (needing.length === 0) return facts;

  const rows = unwrap(
    await db()
      .from("payment_approvals")
      .select(`source_id, ${COLUMNS}`)
      .eq("source_type", type)
      .in("source_id", needing.map((item) => item.id))
      .is("used_at", null)
      .order("approved_at", { ascending: true })
  ) as Array<ApprovalRow & { source_id: string }>;
  const agreeing = new Map<string, GivenApproval[]>();
  for (const item of needing) {
    agreeing.set(
      item.id,
      rows.filter((row) => row.source_id === item.id).map(given).filter((approval) => approvalAgrees(approval, item.payment))
    );
  }
  const givers = [...new Set([...agreeing.values()].flat().map((approval) => approval.by))];
  const approvers = givers.length > 0 ? await approversAmong(givers) : new Set<string>();

  // One count per set of people left out, however many payments share it.
  const counts = new Map<string, number>();
  for (const item of needing) {
    const excluded = memberIds(item.excluded);
    const key = [...excluded].sort().join(",");
    if (excluded.length > 0 && !counts.has(key)) counts.set(key, await approversBesides(excluded));
    facts.set(item.id, {
      above,
      approvals: (agreeing.get(item.id) ?? []).filter((approval) => approvers.has(approval.by)).map((approval) => ({ by: approval.by, at: approval.at })),
      fewApprovers: excluded.length > 0 && (counts.get(key) ?? 2) < 2,
    });
  }
  return facts;
}
