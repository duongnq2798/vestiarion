import { committedState } from "@/lib/agent/duplicates";
import { invoiceDiscount } from "@/lib/agent/payment-timing";
import { utcDay } from "@/lib/copy";
import type { LedgerEntry } from "@/lib/ledger";
import type { CounterpartyRow, InvoiceRow, MilestoneRow, TreasuryActionRow } from "@/lib/queries";
import type { Decision, Evidence, Outcome } from "./types";
import { fmt } from "./Primitives";

/**
 * Renders the duplicate-billing check as evidence in its own right — including
 * when it found nothing. "Checked 8 earlier invoices, no repeat" is the half of
 * a fraud control that a display which only shows hits can never prove, and it
 * is the half a reviewer needs in order to trust the other one.
 *
 * Returns null only for invoices decided before the check existed, where
 * claiming either result would be an invention.
 */
function duplicateEvidence(observed: Record<string, unknown> | undefined): Evidence | null {
  const check = record(observed?.duplicateCheck);
  if (!check) return null;

  const matches = Array.isArray(check.matches) ? check.matches : [];
  const considered = numberValue(check.candidatesConsidered) ?? 0;
  if (matches.length === 0) {
    return {
      label: "Duplicate check",
      value: `clear against ${considered} earlier invoice${considered === 1 ? "" : "s"}`,
      state: "ok",
    };
  }

  const strongest = record(matches[0]);
  const confidence = numberValue(strongest?.confidence);
  // Worded as the match's own explanation words it (./duplicates.ts): already
  // paid, being paid, scheduled or being decided by a person.
  const committed = committedState(stringValue(strongest?.otherInvoiceStatus) ?? "");
  return {
    label: "Duplicate check",
    value: `${matches.length} match${matches.length === 1 ? "" : "es"}${
      confidence == null ? "" : ` at ${(confidence * 100).toFixed(0)}%`
    }${committed ? ` against an invoice ${committed}` : ""}`,
    state: "missing",
  };
}

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

/**
 * The invoice's payment terms, as a fact a person reads next to the decision
 * — not only in the agent's reasoning — when it carries an early-payment
 * discount (payment timing design §1, "What a person sees").
 */
function termsEvidence(invoice: InvoiceRow): Evidence | null {
  const discount = invoiceDiscount(invoice);
  if (!discount) return null;
  return { label: "Terms", value: `${discount.pct}% off if paid by ${utcDay(discount.deadline)}`, state: "neutral" };
}

/**
 * What actually left, when it paid less than the invoice's full amount — an
 * early-payment discount taken. `invoice.amount` is never reduced, so this is
 * the only place the discounted transfer is shown next to the decision.
 */
function paidEvidence(invoice: InvoiceRow): Evidence | null {
  if (invoice.status !== "paid" || invoice.paid_amount == null || invoice.paid_amount >= invoice.amount) return null;
  const pct = invoice.early_pay_discount_pct == null ? null : Number(invoice.early_pay_discount_pct);
  const note = pct != null && Number.isFinite(pct) ? ` (${pct}% discount)` : "";
  return { label: "Paid", value: `${fmt(invoice.paid_amount)} USDC${note}`, state: "ok" };
}

/**
 * What the outcome badge says for an invoice whose outcome word alone would
 * mislead: only a scheduled invoice reads "Scheduled", with its day. A
 * pending one has not been decided yet, a matched one has a transfer in
 * flight, and a processing one is with a person on Approvals, though all
 * three share the neutral outcome.
 */
function invoiceOutcomeLabel(invoice: InvoiceRow, guardrailBlocked: boolean): string | undefined {
  switch (invoice.status) {
    case "awaiting_info":
      return "Awaiting info";
    case "flagged":
      return guardrailBlocked ? undefined : "Flagged for review";
    case "scheduled":
      return invoice.scheduled_for ? `Scheduled for ${utcDay(invoice.scheduled_for)}` : undefined;
    case "pending":
      // The agent decides payables, never receivables — a receivable just
      // waits on the counterparty to pay it.
      return invoice.direction === "receivable" ? "Awaiting payment" : "Not yet decided";
    case "matched":
      return "Payment in flight";
    case "processing":
      return "Being decided by a person";
    case "paid":
      // A recognised tx_ref already reads as paid through its own outcome
      // word ("Settled on Arc" / "Simulated"); an unrecognised or missing one
      // — sample history, or a row from before tx_ref was recorded — must
      // still read as paid, never fall through to the default "Scheduled".
      return invoice.tx_ref?.startsWith("0x") || invoice.tx_ref?.startsWith("sim_") ? undefined : "Paid";
    default:
      return undefined;
  }
}

function statusOutcome(status: string, txRef: string | null, guardrailBlocked: boolean): Outcome {
  if (guardrailBlocked) return "refused";
  if (status === "paid" && txRef?.startsWith("0x")) return "settled";
  if (status === "paid" && txRef?.startsWith("sim_")) return "simulated";
  // A paid invoice whose tx_ref is missing or unrecognised must never fall
  // through to the default "scheduled" outcome below — that reads as
  // "Scheduled", which a paid invoice never is (spec §1, "never Scheduled
  // otherwise").
  if (status === "paid") return "recorded";
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
    outcomeLabel: invoiceOutcomeLabel(invoice, guardrailBlocked),
    reasoning: invoice.agent_reasoning ?? "The agent has not evaluated this invoice yet.",
    evidence: [
      { label: "PO", value: invoice.po_reference ?? "none", state: invoice.po_reference ? "ok" : "missing" },
      { label: "Goods received", value: invoice.goods_received ? "yes" : "no", state: invoice.goods_received ? "ok" : "missing" },
      { label: "Risk", value: risk, state: risk === "high" ? "missing" : "neutral" },
      { label: "Limit", value: counterparty?.payment_limit == null ? "none" : `${fmt(counterparty.payment_limit)} USDC`, state: counterparty?.payment_limit != null && invoice.amount > counterparty.payment_limit ? "missing" : "neutral" },
      { label: "Due", value: new Date(invoice.due_date).toLocaleDateString("en-US"), state: "neutral" },
      termsEvidence(invoice),
      paidEvidence(invoice),
      duplicateEvidence(observed),
    ].filter((item): item is Evidence => item !== null),
    guardrail: guardrailBlocked ? { rule, attempted: invoice.amount, limit, note: risk === "high" ? "risk tier high" : "amount above screened limit" } : null,
    decisionMode: stringValue(entry?.detail.decisionMode),
    txHash: invoice.tx_ref?.startsWith("0x") ? invoice.tx_ref : null,
    auditSeq: entry?.seq,
    at: entry?.ts ?? invoice.due_date,
  };
}

/** A milestone's evidence as a link a person can open: an https address, other than a pull request (the Verified by row links that). */
function milestoneEvidenceLink(source: string | null, githubSource: string | undefined): { href: string; host: string } | null {
  if (!source || githubSource) return null;
  try {
    const url = new URL(source);
    return url.protocol === "https:" && url.hostname ? { href: url.href, host: url.hostname } : null;
  } catch {
    return null;
  }
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
  const evidenceLink = milestoneEvidenceLink(milestone.verification_source, githubSource);
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
      ...(evidenceLink ? [{ label: "Evidence", value: evidenceLink.host, href: evidenceLink.href, state: "neutral" as const }] : []),
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
