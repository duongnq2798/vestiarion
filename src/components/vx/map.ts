import type { LedgerEntry } from "@/lib/ledger";
import type { CounterpartyRow, InvoiceRow, MilestoneRow, TreasuryActionRow } from "@/lib/queries";
import type { Decision, Outcome } from "./types";
import { fmt } from "./Primitives";

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function matchingEntry(entries: LedgerEntry[], key: "invoiceId" | "milestoneId", id: string) {
  return entries.find((entry) => entry.detail[key] === id);
}

function statusOutcome(status: string, txRef: string | null, guardrailBlocked: boolean): Outcome {
  if (guardrailBlocked) return "refused";
  if (status === "paid" && txRef?.startsWith("0x")) return "settled";
  if (status === "paid" && txRef?.startsWith("sim_")) return "simulated";
  if (["held", "flagged", "awaiting_info"].includes(status)) return "held";
  if (["received", "rejected"].includes(status)) return "recorded";
  return "scheduled";
}

export function invoiceDecision(invoice: InvoiceRow, counterparty: CounterpartyRow | undefined, entries: LedgerEntry[]): Decision {
  const entry = matchingEntry(entries, "invoiceId", invoice.id);
  const observed = record(entry?.detail.observed);
  const guardrailBlocked = entry?.detail.guardrailBlocked === true;
  const limit = numberValue(observed?.paymentLimit) ?? counterparty?.payment_limit ?? 0;
  const risk = stringValue(observed?.riskLevel) ?? counterparty?.risk_level ?? "unscreened";
  const outcome = statusOutcome(invoice.status, invoice.tx_ref, guardrailBlocked);
  const rule = risk === "high" ? "counterparty.high_risk" : "counterparty.payment_limit";

  return {
    id: invoice.id,
    domain: invoice.direction === "receivable" ? "ar" : "ap",
    action: invoice.direction === "receivable" ? "Collect from" : "Pay",
    subject: invoice.counterparty_name,
    memo: invoice.memo ?? undefined,
    amount: invoice.amount,
    token: "USDC",
    outcome,
    outcomeLabel: invoice.status === "awaiting_info" ? "Awaiting info" : invoice.status === "flagged" && !guardrailBlocked ? "Flagged for review" : undefined,
    reasoning: invoice.agent_reasoning ?? "The agent has not evaluated this invoice yet.",
    evidence: [
      { label: "PO", value: invoice.po_reference ?? "none", state: invoice.po_reference ? "ok" : "missing" },
      { label: "Goods received", value: invoice.goods_received ? "yes" : "no", state: invoice.goods_received ? "ok" : "missing" },
      { label: "Risk", value: risk, state: risk === "high" ? "missing" : "neutral" },
      { label: "Limit", value: counterparty?.payment_limit == null ? "none" : `${fmt(counterparty.payment_limit)} USDC`, state: counterparty?.payment_limit != null && invoice.amount > counterparty.payment_limit ? "missing" : "neutral" },
      { label: "Due", value: new Date(invoice.due_date).toLocaleDateString("en-US"), state: "neutral" },
    ],
    guardrail: guardrailBlocked ? { rule, attempted: invoice.amount, limit, note: risk === "high" ? "risk tier high" : "amount above screened limit" } : null,
    decisionMode: stringValue(entry?.detail.decisionMode),
    txHash: invoice.tx_ref?.startsWith("0x") ? invoice.tx_ref : null,
    auditSeq: entry?.seq,
    at: entry?.ts ?? invoice.due_date,
  };
}

export function milestoneDecision(milestone: MilestoneRow, entries: LedgerEntry[]): Decision {
  const entry = matchingEntry(entries, "milestoneId", milestone.id);
  const observed = record(entry?.detail.observed);
  const guardrailBlocked = entry?.detail.guardrailBlocked === true;
  const limit = numberValue(observed?.paymentLimit) ?? 0;
  const risk = stringValue(observed?.riskLevel) ?? "unscreened";
  const githubSource = milestone.verification_source?.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/)?.[0];
  const verificationLabel = milestone.verification_method === "github"
    ? milestone.verification_status === "verified" ? "merged PR" : milestone.verification_status.replace("_", " ")
    : milestone.verification_method === "manual" ? "manual approval" : milestone.verification_method === "seed" ? "demo fixture" : "not verified";
  return {
    id: milestone.id,
    domain: "contractor",
    action: "Release",
    subject: milestone.contractor_name,
    memo: milestone.title,
    amount: milestone.amount,
    token: "USDC",
    outcome: statusOutcome(milestone.status, milestone.tx_ref, guardrailBlocked),
    reasoning: milestone.agent_reasoning ?? "The agent is waiting for milestone verification.",
    evidence: [
      { label: "Verified by", value: verificationLabel, href: githubSource, state: milestone.verified ? "ok" : "missing" },
      { label: "Verified", value: milestone.verified ? "yes" : "not yet", state: milestone.verified ? "ok" : "missing" },
      { label: "Risk", value: risk, state: risk === "high" ? "missing" : "neutral" },
    ],
    guardrail: guardrailBlocked ? { rule: risk === "high" ? "counterparty.high_risk" : "counterparty.payment_limit", attempted: milestone.amount, limit, note: risk === "high" ? "risk tier high" : "amount above screened limit" } : null,
    decisionMode: stringValue(entry?.detail.decisionMode),
    txHash: milestone.tx_ref?.startsWith("0x") ? milestone.tx_ref : null,
    auditSeq: entry?.seq,
    at: entry?.ts ?? new Date().toISOString(),
  };
}

export function treasuryLedgerDecision(entry: LedgerEntry): Decision {
  const decision = record(entry.detail.decision);
  const economics = record(entry.detail.economics);
  const action = stringValue(decision?.action) ?? entry.action;
  const amount = numberValue(decision?.amount) ?? 0;
  const earnMode = stringValue(entry.detail.earnMode);
  const executed = entry.detail.executed === true;
  const outcome: Outcome = action === "hold" ? "held" : earnMode === "live" && executed ? "recorded" : "simulated";
  const title = action === "sweep_to_usyc" ? "Sweep" : action === "redeem_from_usyc" ? "Redeem" : "Hold";
  const evidence = [
    { label: "Idle above buffer", value: `${fmt(numberValue(economics?.idleAboveBuffer) ?? 0)} USDC`, state: "neutral" as const },
    { label: "Required buffer", value: `${fmt(numberValue(economics?.requiredBuffer) ?? 0)} USDC`, state: "neutral" as const },
    { label: "Hold horizon", value: `${numberValue(economics?.expectedHoldDays) ?? 0} day(s)`, state: "neutral" as const },
    { label: "Projected yield", value: `$${fmt(numberValue(economics?.projectedYieldUsd) ?? 0)}`, state: "neutral" as const },
    { label: "Round-trip cost", value: `$${fmt(numberValue(economics?.roundTripCostUsd) ?? 0)}`, state: "neutral" as const },
  ];

  return {
    id: entry.id,
    domain: "treasury",
    action: title,
    subject: title === "Hold" ? "operating cash" : "USDC ↔ USYC reserve",
    amount: amount > 0 ? amount : undefined,
    token: "USDC",
    outcome,
    outcomeLabel: title === "Hold" ? "Held liquid" : undefined,
    reasoning: stringValue(decision?.reasoning) ?? entry.summary,
    evidence,
    decisionMode: stringValue(entry.detail.decisionMode),
    auditSeq: entry.seq,
    at: entry.ts,
  };
}

export function treasuryActionDecision(action: TreasuryActionRow): Decision {
  return {
    id: action.id,
    domain: "treasury",
    action: action.action === "sweep_to_usyc" ? "Sweep" : "Redeem",
    subject: action.action === "sweep_to_usyc" ? "USDC → USYC reserve" : "USYC reserve → USDC",
    amount: action.amount,
    token: "USDC",
    outcome: "simulated",
    reasoning: action.reasoning,
    evidence: [],
    at: action.created_at,
  };
}
