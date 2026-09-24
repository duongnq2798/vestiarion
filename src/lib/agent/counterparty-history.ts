import { DUPLICATE_BLOCK_CONFIDENCE } from "./duplicates";

export interface CounterpartyHistoryInputs {
  paidWithoutIntervention: number;
  informationRequested: number;
  heldOrFlagged: number;
  duplicateSubmissions: number;
  riskTierChanges: number;
  /**
   * Holds caused by *our* configuration rather than their conduct: an amount
   * above the limit we set, or a risk tier screening assigned. Recorded and
   * shown, but deliberately kept out of the arithmetic — see the note on
   * `derivePerformanceScore`.
   */
  heldByOurPolicy: number;
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
    heldByOurPolicy: 0,
  };
}

/**
 * Weight of the "no information" position, in pseudo-observations. Two means a
 * counterparty needs a few real outcomes before the score moves far from 0.5.
 */
export const PERFORMANCE_PRIOR_WEIGHT = 2;

/**
 * The share of observed outcomes that completed cleanly — pulled toward 0.5
 * until there is enough evidence to leave it.
 *
 * A raw ratio was the first attempt and it made a strong claim from weak
 * evidence: one held invoice scored a counterparty 0.000, one clean payment
 * scored it 1.000, and a vendor with a single observation was indistinguishable
 * from one with fifty. Those are the numbers a reviewer would act on.
 *
 * Shrinking toward 0.5 fixes that without inventing a prior: 0.5 is the absence
 * of information, not a guess about the counterparty. One clean payment now
 * reads 0.667 and one adverse outcome 0.333 — real signal, honestly weak. The
 * disclosed counts still let a reviewer reconstruct the arithmetic, and
 * `observations` says how much evidence is behind it.
 *
 * `heldByOurPolicy` is excluded on purpose. A payment held because the amount
 * exceeded the limit *we* configured, or because screening assigned a risk
 * tier, says nothing about how the counterparty behaves — and the risk tier is
 * already in front of the model as `riskLevel`. Counting it here would mark a
 * vendor down for our own settings and show the same negative fact twice.
 */
export function derivePerformanceScore(
  inputs: CounterpartyHistoryInputs
): CounterpartyPerformance {
  const clean = inputs.paidWithoutIntervention;
  const adverse =
    inputs.informationRequested +
    inputs.heldOrFlagged +
    inputs.duplicateSubmissions +
    inputs.riskTierChanges;
  const observations = clean + adverse;

  if (observations === 0) {
    return { score: null, observations: 0, inputs: { ...inputs } };
  }

  const smoothed =
    (clean + PERFORMANCE_PRIOR_WEIGHT / 2) / (observations + PERFORMANCE_PRIOR_WEIGHT);
  return {
    score: Number(smoothed.toFixed(3)),
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
  heldByOurPolicy: boolean;
  duplicateSubmitted: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Whether a hold was our doing rather than theirs.
 *
 * An invoice held because it exceeded the limit *we* configured, or because
 * screening assigned a risk tier, is a statement about our own risk appetite.
 * The counterparty may have done nothing wrong at all — Wardrobe Holdings was
 * scored 0.000 on a perfectly matched invoice whose only fault was that
 * screening had tiered its limit underneath it, a fact already sitting in front
 * of the model as `riskLevel`.
 */
function heldByOurConfiguration(entry: CounterpartyHistoryLedgerEntry): boolean {
  const rule = entry.detail.guardrailRule;
  if (rule === "counterparty.payment_limit" || rule === "counterparty.high_risk") return true;

  const observed = record(entry.detail.observed);
  if (!observed) return false;

  const risk = observed.riskLevel;
  if (risk === "high" || risk === "medium") return true;

  const limit = observed.paymentLimit;
  const amount = observed.amount;
  return (
    typeof limit === "number" &&
    typeof amount === "number" &&
    amount > limit
  );
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
      heldByOurPolicy: false,
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
      if (heldByOurConfiguration(entry)) subject.heldByOurPolicy = true;
      else subject.heldOrFlagged = true;
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
      !subject.heldByOurPolicy &&
      !subject.duplicateSubmitted
    ) {
      history.paidWithoutIntervention += 1;
    }
    if (subject.informationRequested) history.informationRequested += 1;
    if (subject.duplicateSubmitted) history.duplicateSubmissions += 1;
    else if (subject.heldOrFlagged) history.heldOrFlagged += 1;
    else if (subject.heldByOurPolicy) history.heldByOurPolicy += 1;
  }

  return histories;
}
