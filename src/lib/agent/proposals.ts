import { z } from "zod";
import { unwrap, type OrgDb } from "../dal";
import { appendLedgerEntry } from "../ledger";
import { decide } from "./decide";
import type { CycleLogLine } from "./orchestrator";
import { REASONING_RULE, REASONING_SHAPE } from "../reasoning-copy";

/**
 * The cycle's proposals stage (docs/superpowers/specs/2026-10-02-limit-proposals-design.md): when
 * people keep approving one counterparty's payments above its payment limit, the agent proposes a
 * higher limit, for a person to accept or dismiss. The model decides whether to propose and what;
 * code bounds it (R3). It changes nothing itself: accepting is a person's limit change (R4).
 */

const WINDOW_DAYS = 30;
const MIN_OVERRIDES = 2;
const DAY_MS = 86_400_000;
const EPSILON = 0.0000005;

export interface OverrideEvidence {
  invoiceId: string;
  /** What it was weighed at against the limit: its USDC value. */
  amountUsdc: number;
  approvedAt: string;
  approvedBy: string | null;
  /** What the agent did with it before a person approved it. */
  agentAction: string;
  guardrailRule: string | null;
  /** The limit it was above when the agent decided. */
  limitAtDecision: number;
}

export interface LimitCandidate {
  counterpartyId: string;
  name: string;
  currentLimit: number;
  overrides: OverrideEvidence[];
  maxOverride: number;
  rejections: number;
  performanceScore: number | null;
}

interface LedgerRow {
  seq?: number;
  ts: string;
  action: string;
  detail: Record<string, unknown>;
}

interface CounterpartyRow {
  id: string;
  name: string;
  role: string;
  risk_level: string;
  baseline_payment_limit: string | number | null;
  payment_limit: string | number | null;
  performance_score?: string | number | null;
}

interface ProposalRow {
  counterparty_id: string;
  status: string;
  decided_at: string | null;
  created_at: string;
}

const num = (value: unknown): number | null => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Rounded up to a figure a person would set: to 0.1 below 1 USDC, to 1 below 100, to 10 above. */
export function niceCeil(value: number): number {
  const step = value < 1 ? 0.1 : value < 100 ? 1 : 10;
  return Number((Math.ceil(value / step - EPSILON) * step).toFixed(6));
}

/** The reference proposal: the largest override and 10% more, rounded up (R3). */
export function referenceLimit(maxOverride: number): number {
  return niceCeil(maxOverride * 1.1);
}

/** A proposed limit code accepts: from the largest override to twice it, and above today's (R3). */
export function boundLimit(proposed: number, maxOverride: number, currentLimit: number): number | null {
  if (!Number.isFinite(proposed) || proposed + EPSILON < maxOverride || proposed > maxOverride * 2 + EPSILON || proposed <= currentLimit + EPSILON) return null;
  return Number(proposed.toFixed(6));
}

/** What the agent weighed an invoice at, and the limit then, from its decision entry. */
function weighed(decision: LedgerRow): { amount: number; limit: number } | null {
  const observed = record(decision.detail.observed);
  const amount = num(decision.detail.usdcValue) ?? num(observed?.amount);
  const limit = num(observed?.paymentLimit);
  return amount !== null && limit !== null ? { amount, limit } : null;
}

/**
 * The counterparties people have repeatedly approved above their limit (R1, R2). Pure: the stage
 * reads the ledger, invoices, counterparties and proposals, and this decides.
 */
export function limitCandidates(input: {
  now: Date;
  approvals: LedgerRow[];
  decisions: Map<string, LedgerRow>;
  invoiceCounterparty: Map<string, string>;
  counterparties: CounterpartyRow[];
  proposals: ProposalRow[];
  declines: Array<{ counterpartyId: string; ts: string }>;
}): LimitCandidate[] {
  const since = input.now.getTime() - WINDOW_DAYS * DAY_MS;
  const byCounterparty = new Map<string, { overrides: OverrideEvidence[]; rejections: number }>();
  const entry = (id: string) => byCounterparty.get(id) ?? byCounterparty.set(id, { overrides: [], rejections: 0 }).get(id)!;

  for (const approval of input.approvals) {
    if (Date.parse(approval.ts) < since) continue;
    const invoiceId = typeof approval.detail.invoiceId === "string" ? approval.detail.invoiceId : null;
    if (!invoiceId) continue;
    const decision = input.decisions.get(invoiceId);
    const facts = decision ? weighed(decision) : null;
    if (!decision || !facts || facts.amount <= facts.limit + EPSILON) continue;
    const counterpartyId = (typeof approval.detail.counterpartyId === "string" ? approval.detail.counterpartyId : null) ?? input.invoiceCounterparty.get(invoiceId);
    if (!counterpartyId) continue;
    if (approval.action === "approval_rejected") {
      entry(counterpartyId).rejections += 1;
    } else if (approval.action === "approval_paid") {
      entry(counterpartyId).overrides.push({
        invoiceId,
        amountUsdc: facts.amount,
        approvedAt: approval.ts,
        approvedBy: typeof approval.detail.by === "string" ? approval.detail.by : null,
        agentAction: decision.action,
        guardrailRule: typeof decision.detail.guardrailRule === "string" ? decision.detail.guardrailRule : null,
        limitAtDecision: facts.limit,
      });
    }
  }

  const candidates: LimitCandidate[] = [];
  for (const counterparty of input.counterparties) {
    const found = byCounterparty.get(counterparty.id);
    if (!found) continue;
    const currentLimit = num(counterparty.baseline_payment_limit);
    if (currentLimit === null) continue;
    if (counterparty.role === "client" || counterparty.risk_level !== "clear") continue;
    if (found.rejections > 0) continue;
    // Only what is still above today's limit: a limit raised since has answered the rest.
    const overrides = found.overrides.filter((o) => o.amountUsdc > currentLimit + EPSILON).sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
    if (overrides.length < MIN_OVERRIDES) continue;
    const mine = input.proposals.filter((p) => p.counterparty_id === counterparty.id);
    if (mine.some((p) => p.status === "open")) continue;
    // After a dismissal, or the model's own decision not to propose, only a newer override reopens the question.
    const latestOverride = overrides[overrides.length - 1].approvedAt;
    const settledAt = [
      ...mine.filter((p) => p.status === "dismissed").map((p) => p.decided_at ?? p.created_at),
      ...input.declines.filter((d) => d.counterpartyId === counterparty.id).map((d) => d.ts),
    ].sort().pop();
    if (settledAt && Date.parse(latestOverride) <= Date.parse(settledAt)) continue;
    candidates.push({
      counterpartyId: counterparty.id,
      name: counterparty.name,
      currentLimit,
      overrides,
      maxOverride: Math.max(...overrides.map((o) => o.amountUsdc)),
      rejections: found.rejections,
      performanceScore: num(counterparty.performance_score),
    });
  }
  return candidates;
}

const SYSTEM_PROMPT = `You are the treasury agent of a business that pays its vendors and contractors in USDC and EURC on Arc testnet. You hold a payment for a person to decide when it is above the counterparty's payment limit, and people decide those in an approvals inbox.

Now decide whether people's decisions show that a counterparty's payment limit is too low, and if so propose a new one. A person must accept your proposal before anything changes; you are not changing it yourself.

- Propose only when the approvals show a steady pattern of legitimate payments above the limit, not a one-off.
- The new limit should cover the payments people approved, with a small margin, and not much more: a limit is a control, and a higher one lets larger payments go without a person.
- Cite the approvals you rely on: their amounts and dates.
- ${REASONING_RULE}

Respond with ONLY a single JSON object in the requested shape. No prose outside the JSON.`;

const proposalSchema = z.object({
  action: z.enum(["propose", "no_change"]),
  newLimit: z.coerce.number().positive().optional(),
  reasoning: z.string().min(1).max(2000),
});
type ProposalDecision = z.infer<typeof proposalSchema>;

function referenceDecision(candidate: LimitCandidate): ProposalDecision {
  const to = referenceLimit(candidate.maxOverride);
  return {
    action: "propose",
    newLimit: to,
    reasoning: `People approved ${candidate.overrides.length} payments to ${candidate.name} above its ${candidate.currentLimit} USDC limit in the last ${WINDOW_DAYS} days (largest ${candidate.maxOverride} USDC). A limit of ${to} USDC covers them with a 10% margin, so payments like these would no longer wait for a person.`,
  };
}

/**
 * The stage itself: every candidate, the model's answer bounded by code, an open proposal for each
 * one it makes, and a signed entry either way, so the same evidence is not weighed again.
 */
export async function proposeLimitChanges(orgDb: OrgDb, now: Date = new Date()): Promise<CycleLogLine[]> {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const approvals = unwrap(
    await orgDb.from("ledger_entries").select("ts, action, detail").in("action", ["approval_paid", "approval_rejected"]).gte("ts", since)
  ) as LedgerRow[];
  if (approvals.length === 0) return [];

  const invoiceIds = [...new Set(approvals.map((a) => a.detail.invoiceId).filter((id): id is string => typeof id === "string"))];
  const [decisionRows, invoices, proposals, declineRows] = await Promise.all([
    orgDb.from("ledger_entries").select("seq, ts, action, detail").eq("actor", "agent").eq("domain", "ap").in("detail->>invoiceId", invoiceIds).order("seq", { ascending: false }),
    orgDb.from("invoices").select("id, counterparty_id").in("id", invoiceIds),
    orgDb.from("policy_proposals").select("counterparty_id, status, decided_at, created_at").eq("kind", "raise_limit"),
    orgDb.from("ledger_entries").select("ts, detail").eq("action", "policy_proposal_declined").gte("ts", since),
  ]);
  const decisions = new Map<string, LedgerRow>();
  for (const row of unwrap(decisionRows) as LedgerRow[]) {
    const invoiceId = row.detail.invoiceId as string;
    // The latest decision that weighed it, not a reconcile of its transfer.
    if (decisions.has(invoiceId) || !row.action.startsWith("ap_") || row.action === "ap_reconcile" || !record(row.detail.observed)) continue;
    decisions.set(invoiceId, row);
  }
  const invoiceCounterparty = new Map((unwrap(invoices) as Array<{ id: string; counterparty_id: string }>).map((i) => [i.id, i.counterparty_id]));
  const counterpartyIds = [...new Set([...invoiceCounterparty.values(), ...approvals.map((a) => a.detail.counterpartyId).filter((id): id is string => typeof id === "string")])];
  const counterparties = unwrap(
    await orgDb.from("counterparties").select("id, name, role, risk_level, baseline_payment_limit, payment_limit, performance_score").in("id", counterpartyIds)
  ) as CounterpartyRow[];

  const candidates = limitCandidates({
    now,
    approvals,
    decisions,
    invoiceCounterparty,
    counterparties,
    proposals: unwrap(proposals) as ProposalRow[],
    declines: (unwrap(declineRows) as Array<{ ts: string; detail: Record<string, unknown> }>).flatMap((d) =>
      typeof d.detail.counterpartyId === "string" ? [{ counterpartyId: d.detail.counterpartyId, ts: d.ts }] : []
    ),
  });

  const lines: CycleLogLine[] = [];
  for (const candidate of candidates) {
    const reference = referenceDecision(candidate);
    const { value, mode, agreedWithReference } = await decide<ProposalDecision>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        task: "Decide whether to propose raising this counterparty's payment limit, given what people approved above it.",
        counterparty: { name: candidate.name, paymentLimit: candidate.currentLimit, riskLevel: "clear", performanceScore: candidate.performanceScore },
        approvedAboveLimit: candidate.overrides.map((o) => ({ amountUsdc: o.amountUsdc, approvedAt: o.approvedAt, agentAction: o.agentAction, guardrailRule: o.guardrailRule, limitAtDecision: o.limitAtDecision })),
        rejectedAboveLimit: candidate.rejections,
        windowDays: WINDOW_DAYS,
        bounds: { minimum: candidate.maxOverride, maximum: Number((candidate.maxOverride * 2).toFixed(6)) },
        responseShape: { action: "propose | no_change", newLimit: "number (when proposing)", reasoning: REASONING_SHAPE },
      }),
      schema: proposalSchema,
      fallback: () => reference,
    });

    // Code's bounds on the model's limit (R3): out of bounds, the reference stands.
    const bounded = value.action === "propose" ? boundLimit(value.newLimit ?? Number.NaN, candidate.maxOverride, candidate.currentLimit) : null;
    const decision: ProposalDecision =
      value.action === "propose" && bounded === null
        ? { ...reference, reasoning: `${reference.reasoning} [the model proposed ${value.newLimit ?? "no figure"} USDC, outside ${candidate.maxOverride}–${Number((candidate.maxOverride * 2).toFixed(6))} USDC; the reference limit stands]` }
        : value.action === "propose"
          ? { ...value, newLimit: bounded as number }
          : value;
    const evidence = candidate.overrides.map((o) => ({ invoiceId: o.invoiceId, amountUsdc: o.amountUsdc, approvedAt: o.approvedAt, approvedBy: o.approvedBy, agentAction: o.agentAction, guardrailRule: o.guardrailRule }));

    if (decision.action === "no_change") {
      await appendLedgerEntry({
        actor: "agent",
        domain: "compliance",
        action: "policy_proposal_declined",
        summary: `Decided not to propose a higher payment limit for ${candidate.name}`,
        detail: { counterpartyId: candidate.counterpartyId, currentLimit: candidate.currentLimit, evidence, reasoning: decision.reasoning, decisionMode: mode, agreedWithReference },
      });
      continue;
    }

    const inserted = await orgDb
      .from("policy_proposals")
      .insert({
        kind: "raise_limit",
        counterparty_id: candidate.counterpartyId,
        from_limit: candidate.currentLimit,
        to_limit: decision.newLimit,
        evidence,
        reasoning: decision.reasoning,
        decision_mode: mode,
      })
      .select("id")
      .single<{ id: string }>();
    // Another cycle opened one meanwhile: one open proposal per counterparty (0056).
    if (inserted.error?.code === "23505") continue;
    if (inserted.error) throw new Error(inserted.error.message);

    await appendLedgerEntry({
      actor: "agent",
      domain: "compliance",
      action: "policy_proposal_made",
      summary: `Proposed raising ${candidate.name}'s payment limit from ${candidate.currentLimit} to ${decision.newLimit} USDC: people approved ${candidate.overrides.length} payments above it`,
      detail: {
        proposalId: inserted.data.id,
        counterpartyId: candidate.counterpartyId,
        kind: "raise_limit",
        fromLimit: candidate.currentLimit,
        toLimit: decision.newLimit,
        evidence,
        reasoning: decision.reasoning,
        decisionMode: mode,
        referenceLimit: reference.newLimit,
        agreedWithReference,
      },
    });
    lines.push({ domain: "compliance", message: `Proposed raising ${candidate.name}'s limit from ${candidate.currentLimit} to ${decision.newLimit} USDC, for a person to accept` });
  }
  return lines;
}
