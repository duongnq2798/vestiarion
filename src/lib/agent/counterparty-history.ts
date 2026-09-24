import { DUPLICATE_BLOCK_CONFIDENCE } from "./duplicates";

export interface CounterpartyHistoryInputs {
  paidWithoutIntervention: number;
  informationRequested: number;
  heldOrFlagged: number;
  duplicateSubmissions: number;
  riskTierChanges: number;
}

export interface CounterpartyPerformance {
  score: number | null;
  observations: number;
  inputs: CounterpartyHistoryInputs;
}

export interface CounterpartyHistoryLedgerEntry {
  domain: string;
  action: string;
  detail: Record<string, unknown>;
}

export interface CounterpartyHistoryTargets {
  invoiceCounterparty: ReadonlyMap<string, string>;
  milestoneCounterparty: ReadonlyMap<string, string>;
}

export const COUNTERPARTY_HISTORY_ACTIONS = [
  "ap_pay",
  "ap_hold",
  "ap_flag_fraud",
  "ap_request_info",
  "milestone_release",
  "milestone_hold",
  "risk_level_changed",
] as const;

export const PERFORMANCE_SCORE_MATERIAL_DELTA = 0.01;

export function emptyCounterpartyHistory(): CounterpartyHistoryInputs {
  return {
    paidWithoutIntervention: 0,
    informationRequested: 0,
    heldOrFlagged: 0,
    duplicateSubmissions: 0,
    riskTierChanges: 0,
  };
}

/**
 * The score is the share of observed outcomes that completed cleanly. Each
 * intervention or adverse fact contributes one observation, so the result is
 * evidence a reviewer can reconstruct from the disclosed counts rather than
 * a hidden weighting or a prior dressed up as measurement.
 */
export function derivePerformanceScore(
  inputs: CounterpartyHistoryInputs
): CounterpartyPerformance {
  const observations =
    inputs.paidWithoutIntervention +
    inputs.informationRequested +
    inputs.heldOrFlagged +
    inputs.duplicateSubmissions +
    inputs.riskTierChanges;

  return {
    score:
      observations === 0
        ? null
        : Number((inputs.paidWithoutIntervention / observations).toFixed(3)),
    observations,
    inputs: { ...inputs },
  };
}

export function isMaterialPerformanceChange(
  previous: number | null,
  next: number | null
): boolean {
  if (previous === next) return false;
  if (previous == null || next == null) return true;
  return Math.abs(previous - next) >= PERFORMANCE_SCORE_MATERIAL_DELTA;
}

interface SubjectHistory {
  counterpartyId: string;
  paid: boolean;
  informationRequested: boolean;
  heldOrFlagged: boolean;
  duplicateSubmitted: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isConfirmedDuplicate(entry: CounterpartyHistoryLedgerEntry): boolean {
  if (entry.detail.guardrailRule === "invoice.duplicate_of_settled") return true;
  if (entry.action !== "ap_flag_fraud") return false;

  const observed = record(entry.detail.observed);
  const check = record(observed?.duplicateCheck);
  const matches = Array.isArray(check?.matches) ? check.matches : [];
  return matches.some((value) => {
    const match = record(value);
    const status = match?.otherInvoiceStatus;
    const confidence = Number(match?.confidence ?? 0);
    return (
      (status === "paid" || status === "received") &&
      confidence >= DUPLICATE_BLOCK_CONFIDENCE
    );
  });
}

function counterpartyFor(
  detail: Record<string, unknown>,
  targetId: string,
  fallback: ReadonlyMap<string, string>
): string | null {
  return typeof detail.counterpartyId === "string"
    ? detail.counterpartyId
    : fallback.get(targetId) ?? null;
}

/** Builds one set of disclosed score inputs from immutable ledger events. */
export function deriveCounterpartyHistories(
  entries: CounterpartyHistoryLedgerEntry[],
  targets: CounterpartyHistoryTargets
): Map<string, CounterpartyHistoryInputs> {
  const histories = new Map<string, CounterpartyHistoryInputs>();
  const subjects = new Map<string, SubjectHistory>();

  const historyFor = (counterpartyId: string): CounterpartyHistoryInputs => {
    const existing = histories.get(counterpartyId);
    if (existing) return existing;
    const created = emptyCounterpartyHistory();
    histories.set(counterpartyId, created);
    return created;
  };

  for (const entry of entries) {
    if (entry.action === "risk_level_changed") {
      const counterpartyId = entry.detail.counterpartyId;
      if (typeof counterpartyId === "string") historyFor(counterpartyId).riskTierChanges += 1;
      continue;
    }

    const invoiceId = entry.detail.invoiceId;
    const milestoneId = entry.detail.milestoneId;
    const targetId = typeof invoiceId === "string" ? invoiceId : milestoneId;
    if (typeof targetId !== "string") continue;
    const isInvoice = typeof invoiceId === "string";
    const counterpartyId = counterpartyFor(
      entry.detail,
      targetId,
      isInvoice ? targets.invoiceCounterparty : targets.milestoneCounterparty
    );
    if (!counterpartyId) continue;

    const key = `${isInvoice ? "invoice" : "milestone"}:${targetId}`;
    const subject = subjects.get(key) ?? {
      counterpartyId,
      paid: false,
      informationRequested: false,
      heldOrFlagged: false,
      duplicateSubmitted: false,
    };
    const execution = record(entry.detail.execution);

    if (
      (entry.action === "ap_pay" || entry.action === "milestone_release") &&
      execution?.resultingStatus === "paid" &&
      entry.detail.guardrailBlocked !== true
    ) {
      subject.paid = true;
    }
    if (entry.action === "ap_request_info") subject.informationRequested = true;
    if (entry.action === "ap_hold" || entry.action === "milestone_hold") {
      subject.heldOrFlagged = true;
    }
    if (entry.action === "ap_flag_fraud") {
      if (isConfirmedDuplicate(entry)) subject.duplicateSubmitted = true;
      else subject.heldOrFlagged = true;
    }
    subjects.set(key, subject);
  }

  for (const subject of subjects.values()) {
    const history = historyFor(subject.counterpartyId);
    if (
      subject.paid &&
      !subject.informationRequested &&
      !subject.heldOrFlagged &&
      !subject.duplicateSubmitted
    ) {
      history.paidWithoutIntervention += 1;
    }
    if (subject.informationRequested) history.informationRequested += 1;
    if (subject.duplicateSubmitted) history.duplicateSubmissions += 1;
    else if (subject.heldOrFlagged) history.heldOrFlagged += 1;
  }

  return histories;
}
