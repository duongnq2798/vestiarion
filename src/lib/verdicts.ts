import { AGENT_DECISION_ACTIONS } from "./agent/shadow-hold";
import { currentOrgId } from "./context";
import { db, unwrap, type OrgDb } from "./dal";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";
import { heldForVerdict } from "./next-step";
import { readShadowMode, type ShadowMode } from "./shadow-mode";
import type { VerdictFacts } from "./verdict-view";

/**
 * A person's verdict on a decision of the agent's, in shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-design.md
 * S3–S5): Agree or Disagree, once per decision entry, a reason for every disagreement. Only on the agent's decisions
 * about a payable written since shadow mode started. Each is a row in `decision_verdicts`, which keeps it once, and a
 * signed `decision_verdict` entry. Agreeing to a payment held for the verdict pays it, through Approve and pay;
 * disagreeing returns the payable to the agent or rejects it, when the person asks. Every export runs inside an
 * organization scope; who may give one (`approval.decide`) is the caller's check.
 */

export type Verdict = "agree" | "disagree";

export { AGENT_DECISION_ACTIONS };

const REASON_MAX = 280;

export type VerdictErrorCode =
  | "not_in_shadow"
  | "not_a_decision"
  | "before_shadow"
  | "reason_required"
  | "reason_too_long"
  | "pay_needs_agreement"
  | "settle_needs_disagreement";

const MESSAGES: Record<VerdictErrorCode, string> = {
  not_in_shadow: "Verdicts are given in shadow mode. An owner turns it on in Settings.",
  not_a_decision: "That is not a decision of the agent's about a bill.",
  before_shadow: "That decision came before shadow mode started.",
  reason_required: "Say why you disagree, in a few words.",
  reason_too_long: "Keep the reason to 280 characters.",
  pay_needs_agreement: "Only an agreement pays it.",
  settle_needs_disagreement: "Only a disagreement returns or rejects it.",
};

export class VerdictError extends Error {
  constructor(readonly code: VerdictErrorCode) {
    super(MESSAGES[code]);
    this.name = "VerdictError";
  }
}

export interface GivenVerdict {
  verdict: Verdict;
  reason: string | null;
}

/** What follows a verdict once it is recorded: Agree and pay, or Disagree and return or reject. */
export type AfterVerdict = "pay" | "return" | "reject";

/** What an action after a verdict came to, in the words a person reads. */
export interface ActionOutcome {
  ok: boolean;
  message: string;
}

/**
 * What a verdict may do next: the payable commands of whoever gives it (src/lib/commands/payables.ts), so a payment
 * agreed to passes every check Approve and pay has, and its refusals read the same.
 */
export interface VerdictActions {
  approve: (invoiceId: string) => Promise<ActionOutcome>;
  reject: (invoiceId: string, reason: string | null) => Promise<ActionOutcome>;
  returnToAgent: (invoiceId: string) => Promise<ActionOutcome>;
}

const NOT_HELD: ActionOutcome = { ok: false, message: "It no longer waits for your verdict, so nothing was paid." };

type DecisionEntry = { seq: number; ts: string; actor: string; action: string; summary: string; detail: Record<string, unknown> };

function readReason(verdict: Verdict, typed: string | undefined): string | null {
  const reason = (typed ?? "").trim();
  if (reason.length > REASON_MAX) throw new VerdictError("reason_too_long");
  if (verdict === "disagree" && reason === "") throw new VerdictError("reason_required");
  return reason === "" ? null : reason;
}

/** The agent's newest decision about the payable: the one a payment held for a verdict waits on. */
async function newestDecision(invoiceId: string): Promise<DecisionEntry | null> {
  const rows = unwrap(
    await db()
      .from("ledger_entries")
      .select("seq, ts, actor, action, summary, detail")
      .eq("actor", "agent")
      .in("action", [...AGENT_DECISION_ACTIONS])
      .eq("detail->>invoiceId", invoiceId)
      .order("seq", { ascending: false })
      .limit(1)
  ) as DecisionEntry[];
  return rows[0] ?? null;
}

/** Whether the payable still waits for this verdict: held, with this decision its newest, which held it for one. */
async function stillHeldFor(entry: DecisionEntry, invoiceId: string): Promise<boolean> {
  const invoice = (unwrap(await db().from("invoices").select("status").eq("id", invoiceId).limit(1)) as Array<{ status: string }>)[0];
  if (invoice?.status !== "held") return false;
  const newest = await newestDecision(invoiceId);
  return newest !== null && Number(newest.seq) === Number(entry.seq) && heldForVerdict(newest.detail);
}

async function verdictOn(entrySeq: number): Promise<GivenVerdict | null> {
  const rows = unwrap(await db().from("decision_verdicts").select("verdict, reason").eq("entry_seq", entrySeq).limit(1)) as Array<{ verdict: Verdict; reason: string | null }>;
  return rows[0] ? { verdict: rows[0].verdict, reason: rows[0].reason } : null;
}

export async function giveVerdict(
  input: { actorId: string; entrySeq: number; verdict: Verdict; reason?: string; then?: AfterVerdict },
  actions: VerdictActions
): Promise<{ given: GivenVerdict; already: boolean; after?: ActionOutcome }> {
  const shadow = await readShadowMode(db());
  if (!shadow) throw new VerdictError("not_in_shadow");
  if (input.then === "pay" && input.verdict !== "agree") throw new VerdictError("pay_needs_agreement");
  if ((input.then === "return" || input.then === "reject") && input.verdict !== "disagree") throw new VerdictError("settle_needs_disagreement");
  const reason = readReason(input.verdict, input.reason);

  const entry = (
    unwrap(await db().from("ledger_entries").select("seq, ts, actor, action, summary, detail").eq("seq", input.entrySeq).limit(1)) as DecisionEntry[]
  )[0];
  const invoiceId = typeof entry?.detail?.invoiceId === "string" ? entry.detail.invoiceId : null;
  if (!entry || entry.actor !== "agent" || !(AGENT_DECISION_ACTIONS as readonly string[]).includes(entry.action) || !invoiceId) {
    throw new VerdictError("not_a_decision");
  }
  if (Date.parse(entry.ts) < Date.parse(shadow.startedAt)) throw new VerdictError("before_shadow");

  // The row keeps one verdict per decision: a second, from another tab or another person, answers with the first.
  const write = await db().from("decision_verdicts").insert({
    entry_seq: input.entrySeq,
    subject: "invoice",
    subject_id: invoiceId,
    agent_action: entry.action,
    verdict: input.verdict,
    reason,
    decided_by: input.actorId,
  });
  if (write.error) {
    if (write.error.code === "23505") {
      const first = await verdictOn(input.entrySeq);
      if (first) return { given: first, already: true };
    }
    throw new Error(write.error.message);
  }

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ap",
    action: "decision_verdict",
    summary: `${input.verdict === "agree" ? "Agreed" : "Disagreed"} with the agent: ${entry.summary}`,
    // The payable is its subject, never its invoiceId: the card keeps showing the decision, not the verdict on it.
    detail: { by: input.actorId, entrySeq: input.entrySeq, subject: "invoice", subjectId: invoiceId, agentAction: entry.action, verdict: input.verdict, reason },
  });

  const given = { verdict: input.verdict, reason };
  if (input.then === "pay") {
    if (!(await stillHeldFor(entry, invoiceId))) return { given, already: false, after: { ...NOT_HELD } };
    return { given, already: false, after: await actions.approve(invoiceId) };
  }
  if (input.then === "return") return { given, already: false, after: await actions.returnToAgent(invoiceId) };
  if (input.then === "reject") return { given, already: false, after: await actions.reject(invoiceId, reason) };
  return { given, already: false };
}

/** The verdicts given on the decision entries named, by entry. */
export async function readVerdicts(orgDb: OrgDb, entrySeqs: number[]): Promise<Map<number, GivenVerdict & { by: string | null; at: string }>> {
  const verdicts = new Map<number, GivenVerdict & { by: string | null; at: string }>();
  if (entrySeqs.length === 0) return verdicts;
  const rows = unwrap(await orgDb.from("decision_verdicts").select("entry_seq, verdict, reason, decided_by, decided_at").in("entry_seq", entrySeqs)) as Array<{
    entry_seq: number | string;
    verdict: Verdict;
    reason: string | null;
    decided_by: string | null;
    decided_at: string;
  }>;
  for (const row of rows) verdicts.set(Number(row.entry_seq), { verdict: row.verdict, reason: row.reason, by: row.decided_by, at: row.decided_at });
  return verdicts;
}

/**
 * How often people agreed with the agent, and how many payables' newest decisions wait for a verdict, since shadow mode
 * started (S5). A decision without a verdict counts in neither figure.
 */
export async function readShadowSummary(orgDb: OrgDb, shadow: ShadowMode): Promise<{ agreed: number; disagreed: number; waiting: number }> {
  const decisions = unwrap(
    await orgDb
      .from("ledger_entries")
      .select("seq, detail")
      .eq("actor", "agent")
      .in("action", [...AGENT_DECISION_ACTIONS])
      .gte("ts", shadow.startedAt)
      .order("seq", { ascending: false })
  ) as Array<{ seq: number | string; detail: Record<string, unknown> }>;
  const verdicts = unwrap(await orgDb.from("decision_verdicts").select("entry_seq, verdict")) as Array<{ entry_seq: number | string; verdict: Verdict }>;
  const given = new Set(verdicts.map((row) => Number(row.entry_seq)));
  const newest = new Map<string, number>();
  for (const row of decisions) {
    const invoiceId = row.detail?.invoiceId;
    if (typeof invoiceId === "string" && !newest.has(invoiceId)) newest.set(invoiceId, Number(row.seq));
  }
  return {
    agreed: verdicts.filter((row) => row.verdict === "agree").length,
    disagreed: verdicts.filter((row) => row.verdict === "disagree").length,
    waiting: [...newest.values()].filter((seq) => !given.has(seq)).length,
  };
}

/**
 * What the cards need to show and offer verdicts (S3): the workspace's shadow mode, and the verdicts on the agent's
 * decisions among `entries`. Best effort: facts that cannot be read show no verdict at all, and offer none, rather than
 * offer one that may be given already.
 */
export async function verdictFacts(orgDb: OrgDb, entries: Array<{ seq: number; actor: string; action: string }>, canGive: boolean): Promise<VerdictFacts> {
  try {
    const shadow = await readShadowMode(orgDb);
    const decisions = entries.filter((entry) => entry.actor === "agent" && (AGENT_DECISION_ACTIONS as readonly string[]).includes(entry.action)).map((entry) => entry.seq);
    const read = await readVerdicts(orgDb, decisions);
    const given = new Map([...read].map(([seq, verdict]) => [seq, { verdict: verdict.verdict, reason: verdict.reason }] as const));
    return { shadow: shadow ? { startedAt: shadow.startedAt } : null, given, canGive };
  } catch (error) {
    console.error("verdicts not read", error instanceof Error ? error.message : error);
    return { shadow: null, given: new Map(), canGive: false };
  }
}
