export const COUNTERPARTY_ROLES = ["vendor", "client", "contractor"] as const;
export const COUNTERPARTY_RISK_LEVELS = ["unscreened", "clear", "medium", "high"] as const;

export interface CounterpartyPayload {
  id: string;
  name: string;
  role: (typeof COUNTERPARTY_ROLES)[number];
  address: string | null;
  chain: string | null;
  jurisdiction: string | null;
  riskLevel: (typeof COUNTERPARTY_RISK_LEVELS)[number];
  riskNotes: string | null;
  baselinePaymentLimit: number | null;
  paymentLimit: number | null;
  lastScreenedAt: string | null;
  performanceScore: number | null;
  performanceInputs: Record<string, unknown> | null;
  createdAt: string;
}

export interface ScreeningHistoryPayload {
  id: string;
  riskLevel: string;
  source: string;
  notes: string | null;
  rawScore: number | null;
  matchedEntityId: string | null;
  screeningMode: "live" | "simulate";
  status: "complete" | "failed";
  createdAt: string;
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

export function counterpartyFilterError(
  name: "role" | "riskLevel",
  value: string | null
): string | null {
  if (!value) return null;
  const valid = name === "role" ? COUNTERPARTY_ROLES : COUNTERPARTY_RISK_LEVELS;
  return (valid as readonly string[]).includes(value)
    ? null
    : `${name} must be one of ${valid.join(", ")}.`;
}

export function mapCounterparty(row: Record<string, unknown>): CounterpartyPayload {
  return {
    id: String(row.id),
    name: String(row.name),
    role: row.role as CounterpartyPayload["role"],
    address: nullableString(row.address),
    chain: nullableString(row.chain),
    jurisdiction: nullableString(row.jurisdiction),
    riskLevel: row.risk_level as CounterpartyPayload["riskLevel"],
    riskNotes: nullableString(row.risk_notes),
    baselinePaymentLimit: nullableNumber(row.baseline_payment_limit),
    paymentLimit: nullableNumber(row.payment_limit),
    lastScreenedAt: nullableString(row.last_screened_at),
    // No history is different from a zero score and remains null.
    performanceScore: nullableNumber(row.performance_score),
    performanceInputs:
      row.performance_inputs == null
        ? null
        : (row.performance_inputs as Record<string, unknown>),
    createdAt: String(row.created_at),
  };
}

export function mapScreeningHistory(row: Record<string, unknown>): ScreeningHistoryPayload {
  return {
    id: String(row.id),
    riskLevel: String(row.risk_level),
    source: String(row.source),
    notes: nullableString(row.notes),
    rawScore: nullableNumber(row.raw_score),
    matchedEntityId: nullableString(row.matched_entity_id),
    screeningMode: row.screening_mode as ScreeningHistoryPayload["screeningMode"],
    status: row.status as ScreeningHistoryPayload["status"],
    createdAt: String(row.created_at),
  };
}
