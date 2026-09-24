export const MILESTONE_STATUSES = ["pending", "verified", "paid", "held"] as const;

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
    agentReasoning: nullableString(row.agent_reasoning),
    // Simulation references are receipts from this process, not chain hashes.
    txHash: txRef?.startsWith("0x") ? txRef : null,
    contractor: embedded
      ? { id: embedded.id, name: embedded.name, riskLevel: embedded.risk_level }
      : null,
    createdAt: String(row.created_at),
  };
}
