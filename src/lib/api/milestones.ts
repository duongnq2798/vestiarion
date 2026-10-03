export const MILESTONE_STATUSES = ["pending", "verified", "paid", "held", "closed"] as const;

/** The columns a milestone is read with, for the list and for the answer that added one. */
export const MILESTONE_SELECT =
  "id, title, amount, status, verification_source, verification_method, verification_status, verification_checked_at, verified_at, verification_detail, verified, decided_at, settled_at, closed_at, close_reason, agent_reasoning, tx_ref, created_at, counterparties(id, name, risk_level)";

export interface MilestonePayload {
  id: string;
  title: string;
  amount: number;
  status: (typeof MILESTONE_STATUSES)[number];
  verificationSource: string | null;
  verificationMethod: "unverified" | "github" | "manual" | "seed";
  verificationStatus: "unverified" | "verified" | "not_merged" | "unavailable" | "failed";
  verificationCheckedAt: string | null;
  verifiedAt: string | null;
  verificationDetail: Record<string, unknown>;
  verified: boolean;
  decidedAt: string | null;
  settledAt: string | null;
  /** Closed without paying by a person: when, and the reason they gave. */
  closedAt: string | null;
  closeReason: string | null;
  agentReasoning: string | null;
  txHash: string | null;
  contractor: { id: string; name: string; riskLevel: string } | null;
  createdAt: string;
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

export function milestoneStatusError(value: string | null): string | null {
  if (!value || (MILESTONE_STATUSES as readonly string[]).includes(value)) return null;
  return `status must be one of ${MILESTONE_STATUSES.join(", ")}.`;
}

export function mapMilestone(row: Record<string, unknown>): MilestonePayload {
  const embedded = row.counterparties as
    | { id: string; name: string; risk_level: string }
    | null;
  const txRef = nullableString(row.tx_ref);
  return {
    id: String(row.id),
    title: String(row.title),
    amount: Number(row.amount),
    status: row.status as MilestonePayload["status"],
    verificationSource: nullableString(row.verification_source),
    verificationMethod: row.verification_method as MilestonePayload["verificationMethod"],
    verificationStatus: row.verification_status as MilestonePayload["verificationStatus"],
    verificationCheckedAt: nullableString(row.verification_checked_at),
    verifiedAt: nullableString(row.verified_at),
    verificationDetail: (row.verification_detail ?? {}) as Record<string, unknown>,
    verified: row.verified === true,
    decidedAt: nullableString(row.decided_at),
    settledAt: nullableString(row.settled_at),
    closedAt: nullableString(row.closed_at),
    closeReason: nullableString(row.close_reason),
    agentReasoning: nullableString(row.agent_reasoning),
    // Simulation references are receipts from this process, not chain hashes.
    txHash: txRef?.startsWith("0x") ? txRef : null,
    contractor: embedded
      ? { id: embedded.id, name: embedded.name, riskLevel: embedded.risk_level }
      : null,
    createdAt: String(row.created_at),
  };
}
