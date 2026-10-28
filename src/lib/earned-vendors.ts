import { utcDay } from "./copy";
import type { LedgerEntryInput } from "./ledger";
import { ruleInBrief } from "./next-step";

/**
 * Earned vendors, the autonomy ladder's second step (docs/superpowers/specs/2026-10-28-earned-vendors-design.md): an
 * owner's rule, N agreed verdicts in a row, and which vendors meet it. The rules that touch no database: the rule's
 * bounds, what earns it and what starts the count again (AL12), who can earn it (AL13), what changed since the newest
 * signed status (AL16), and the words Settings, the report and the ledger entries say. Pure and browser-safe, as the
 * ladder is (AL14): the report works the statuses out from the facts it already read; ./earned-vendors-store reads and
 * signs them.
 *
 * Step 3 (AL21-AL30): with the owner's switch on, in shadow mode, the agent pays a vendor earned now and recorded earned
 * on its own (./agent/earned-gate), and asks for the verdict after; at most 3 such payments of one vendor wait for a
 * verdict at once (AL26). The status itself is worked out here, as before, and decides nothing else.
 */

/**
 * The fewest agreed verdicts a rule may ask for: `VERDICTS_BEFORE_LIVE`, under which the ladder says too few to tell
 * (autonomy ladder AL4). Written out, so the Settings panel, a client component, does not load the report's module.
 */
export const EARNED_STREAK_MIN = 5;
export const EARNED_STREAK_MAX = 50;
/** The decisions whose Agree counts (AL12): the agent's decisions to pay or schedule a bill. */
export const COUNTED_ACTIONS: readonly string[] = ["ap_pay", "ap_schedule"];
/** The most decisions one `vendor_earned` entry names as its evidence (AL15). */
export const EARNED_EVIDENCE_MAX = 50;
/**
 * The most of one vendor's payments the agent made on its own that may wait for a verdict at once (AL26): with that many
 * waiting, its next payment waits for a verdict, as every payment in shadow mode does, until a person gives one.
 */
export const EARNED_WAITING_MAX = 3;

/** The workspace's rule (AL11), and the switch 0146 adds beside it (AL21). */
export interface EarnedVendorRule {
  /** Agreed verdicts in a row that make a vendor earned; null is no rule. */
  streak: number | null;
  /** The agent pays earned vendors on its own, in shadow mode (AL21, AL22); never on without a rule. */
  payments: boolean;
}

/** A whole number from 5 to 50 (AL11). */
export function validStreak(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= EARNED_STREAK_MIN && value <= EARNED_STREAK_MAX;
}

/** The rule on its `approval_policies` row: no row, no columns (before 0146) or a value out of bounds is none. */
export function earnedRuleFromRow(row: { earned_vendor_streak?: number | string | null; earned_vendor_payments?: boolean | null } | undefined): EarnedVendorRule {
  const raw = row?.earned_vendor_streak;
  const streak = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  if (!validStreak(streak)) return { streak: null, payments: false };
  return { streak, payments: row?.earned_vendor_payments === true };
}

/**
 * Whether a rule that stopped one of a vendor's bills was a check on the vendor or its bill, which starts the count
 * again (AL12): any `counterparty.*` or `invoice.*` rule, or the same purchase order billed twice. The workspace's own
 * limits and rails (`workspace.*`, a project's budget, `fx.*`, `bridge.*`, `treasury.*`, a bank payout) say nothing
 * about the vendor, and never do.
 */
export function breaksEarning(rule: string | null | undefined): boolean {
  if (!rule) return false;
  return rule.startsWith("counterparty.") || rule.startsWith("invoice.") || rule === "obligation.duplicate_reference";
}

/** One step toward a bill's payment: one of the agent's decisions about it, or a person's that paid it (`approval_paid`). */
export interface PaymentStep {
  seq: number;
  action: string;
  /** The agent carried the payment out on its own, for an earned vendor (`detail.earned`, AL27). */
  onItsOwn?: boolean;
  /** How the decision ended (`execution.resultingStatus`); absent on a person's step. */
  resultingStatus?: string | null;
}

/**
 * Whether a bill's payment was the agent's own, for an earned vendor (AL22, AL29): its newest decision carried out on
 * its own ended paid or on its way, and no person paid the bill after it. A decision the live path held (the pause, the
 * cash, a transfer that failed) paid nothing on its own, and a payment a person's Approve and pay or Agree and pay sent
 * after one, both `approval_paid`, is that person's, whatever the agent's decision before it was. Whether the bill is
 * paid now is the caller's to check.
 */
export function paidOnItsOwn(steps: readonly PaymentStep[]): boolean {
  let own: PaymentStep | null = null;
  for (const step of steps) {
    if (step.onItsOwn === true && (step.resultingStatus === "paid" || step.resultingStatus === "matched") && (!own || step.seq > own.seq)) own = step;
  }
  const after = own?.seq;
  return after !== undefined && !steps.some((step) => step.action === "approval_paid" && step.seq > after);
}

/**
 * What the statuses are worked out from: the report's own facts carry these fields (`readReportFacts`), and so does
 * the sync's narrower read (`readEarnedFacts`). A bill's amount is only for the report's list of verdicts. A payee's
 * `riskLevel` is its screening's (`counterparties.risk_level`), which keeps a high-risk payee's limit at 0.
 */
export interface EarnedFacts {
  bills: ReadonlyArray<{
    id: string;
    amount?: number;
    currency?: string;
    payee: { id: string; name: string; sample: boolean; role?: string; riskLevel?: string; paymentLimit?: number | null };
  }>;
  decisions: ReadonlyArray<{
    seq: number;
    ts: string;
    action: string;
    invoiceId: string;
    guardrailBlocked: boolean;
    guardrailRule: string | null;
    resultingStatus: string | null;
    /** The agent carried the payment out on its own, for an earned vendor (`detail.earned`, AL27). */
    onItsOwn?: boolean;
  }>;
  /** `decidedAt` absent reads as now, the strictest: a Disagree then breaks every decision before it. */
  verdicts: ReadonlyArray<{ entrySeq: number; verdict: "agree" | "disagree"; decidedAt?: string }>;
  /**
   * Shadow mode, where it was read: since when a verdict can be given, so a payment made on its own before then waits
   * for none (AL26); null when it is off. Absent, every payment made on its own counts.
   */
  shadow?: { startedAt: string } | null;
}

/** What started a vendor's count again (AL12), and when. */
export interface EarnedBreak {
  kind: "disagreed" | "flagged" | "code_stop";
  at: string;
  /** The decision it was about: the one disagreed with, flagged or stopped. */
  decisionSeq: number;
  /** The rule that stopped or flagged it, where code did. */
  rule: string | null;
}

/** One counted decision: its entry, when, what the agent decided, and its bill's amount. */
export interface EarnedDecision {
  seq: number;
  at: string;
  action: string;
  amount: number | null;
  currency: string | null;
}

/** A vendor's status under a rule (AL12, AL13). `given` is the verdicts on its decisions, as the ladder counts them. */
export type EarnedStatus = { vendorId: string; name: string; given: number } & (
  | {
      state: "earned";
      /** Agreed verdicts in a row: at least the rule's N. */
      agreed: number;
      /** The counted decisions, newest first. */
      counted: EarnedDecision[];
      from: string;
      to: string;
      since: EarnedBreak | null;
      /** Its payments the agent made on its own that wait for a verdict that can still be given (AL26). */
      waiting: number;
      /** `waiting` reached `EARNED_WAITING_MAX`: its next payment waits for a verdict (AL26). */
      paused: boolean;
    }
  | { state: "counting"; agreed: number; needed: number; since: EarnedBreak | null }
  | { state: "cannot"; because: "high_risk" | "no_payment_limit" | "not_a_vendor" }
);

export type EarnedStatusOf<State extends EarnedStatus["state"]> = Extract<EarnedStatus, { state: State }>;

const time = (iso: string) => Date.parse(iso);
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** The newer of two breaks: by time, then by the later decision. */
const newer = (a: EarnedBreak | null, b: EarnedBreak): EarnedBreak => (!a || time(b.at) > time(a.at) || (time(b.at) === time(a.at) && b.decisionSeq > a.decisionSeq) ? b : a);

/**
 * Every non-sample payee with a decision on its bills, with its status under a rule of `streak` (AL12-AL14), in the
 * ladder's vendor order (autonomy ladder AL5): most verdicts first, then by name, then by id. A decision whose bill is
 * not among the facts is left out, as the ladder leaves its verdict out. An earned vendor says how many of its payments
 * the agent made on its own wait for a verdict (AL26).
 */
export function earnedVendors(facts: EarnedFacts, streak: number): EarnedStatus[] {
  const bills = new Map(facts.bills.map((bill) => [bill.id, bill]));
  const verdicts = new Map(facts.verdicts.map((verdict) => [verdict.entrySeq, verdict]));
  // A verdict with no time was given now: after every decision read.
  const now = facts.decisions.reduce((latest, decision) => (time(decision.ts) > time(latest) ? decision.ts : latest), facts.decisions[0]?.ts ?? new Date(0).toISOString());
  // A verdict can be given only on a decision made since shadow mode started (shadow mode S3): one before waits for none.
  const verdictsFrom = facts.shadow === undefined ? -Infinity : facts.shadow ? time(facts.shadow.startedAt) : Infinity;

  type Row = { decision: EarnedFacts["decisions"][number]; bill: EarnedFacts["bills"][number]; verdict: EarnedFacts["verdicts"][number] | undefined };
  const vendors = new Map<string, { payee: EarnedFacts["bills"][number]["payee"]; rows: Row[] }>();
  for (const decision of facts.decisions) {
    const bill = bills.get(decision.invoiceId);
    if (!bill || bill.payee.sample || !bill.payee.id) continue;
    const vendor = vendors.get(bill.payee.id) ?? { payee: bill.payee, rows: [] };
    vendor.rows.push({ decision, bill, verdict: verdicts.get(decision.seq) });
    vendors.set(bill.payee.id, vendor);
  }

  const statuses = [...vendors.values()].map(({ payee, rows }): EarnedStatus => {
    const base = { vendorId: payee.id, name: payee.name, given: rows.filter((row) => row.verdict).length };
    if (payee.role !== "vendor") return { ...base, state: "cannot", because: "not_a_vendor" };
    // Screening keeps a high-risk payee's limit at 0 whatever its owner set (`paymentLimitForRisk`): it says so, rather
    // than asking for a limit that is set already.
    if (payee.riskLevel === "high") return { ...base, state: "cannot", because: "high_risk" };
    if (!(Number(payee.paymentLimit ?? 0) > 0)) return { ...base, state: "cannot", because: "no_payment_limit" };

    let since: EarnedBreak | null = null;
    for (const { decision, verdict } of rows) {
      if (verdict?.verdict === "disagree") since = newer(since, { kind: "disagreed", at: verdict.decidedAt ?? now, decisionSeq: decision.seq, rule: null });
      if (decision.resultingStatus === "flagged" || decision.action === "ap_flag_fraud") {
        since = newer(since, { kind: "flagged", at: decision.ts, decisionSeq: decision.seq, rule: decision.guardrailRule });
      } else if (decision.guardrailBlocked && breaksEarning(decision.guardrailRule)) {
        since = newer(since, { kind: "code_stop", at: decision.ts, decisionSeq: decision.seq, rule: decision.guardrailRule });
      }
    }
    // A decision that is itself a break is at the break's time, never after it, so it never counts.
    const counted = rows
      .filter(({ decision, verdict }) => COUNTED_ACTIONS.includes(decision.action) && verdict?.verdict === "agree" && (!since || time(decision.ts) > time(since.at)))
      .sort((a, b) => b.decision.seq - a.decision.seq)
      .map(({ decision, bill }): EarnedDecision => ({ seq: decision.seq, at: decision.ts, action: decision.action, amount: bill.amount ?? null, currency: bill.currency ?? null }));
    if (counted.length < streak) return { ...base, state: "counting", agreed: counted.length, needed: streak, since };
    const times = counted.map((decision) => decision.at).sort((a, b) => time(a) - time(b));
    // Paid or on its way, on the agent's own decision, with no verdict yet that can still be given (AL26).
    const waiting = rows.filter(
      ({ decision, verdict }) =>
        decision.onItsOwn === true && (decision.resultingStatus === "paid" || decision.resultingStatus === "matched") && !verdict && time(decision.ts) >= verdictsFrom
    ).length;
    return { ...base, state: "earned", agreed: counted.length, counted, from: times[0], to: times[times.length - 1], since, waiting, paused: waiting >= EARNED_WAITING_MAX };
  });
  return statuses.sort((a, b) => b.given - a.given || a.name.localeCompare(b.name, "en") || byText(a.vendorId, b.vendorId));
}

// ---------------------------------------------------------------------------------------------------------------------
// What gets signed (AL15, AL16)

/** Why a vendor recorded earned no longer is (AL16). */
export type LostBecause = "disagreed" | "flagged" | "code_stop" | "rule_changed" | "rule_off" | "high_risk" | "no_payment_limit" | "not_a_vendor";

/** Where a sync ran (AL16): after a verdict, inside a rule change, or as the AP stage started. */
export type EarnedTrigger = "verdict" | "rule" | "cycle";

/** A vendor's newest signed status: its newest `vendor_earned` or `vendor_earned_lost` entry. */
export interface RecordedStatus {
  state: "earned" | "lost";
  seq: number;
  at: string;
}

export type EarnedChange =
  | { vendorId: string; to: "earned"; status: EarnedStatusOf<"earned"> }
  | { vendorId: string; to: "lost"; because: LostBecause; since: EarnedBreak | null };

/**
 * What to sign: each vendor whose status now differs from its newest signed one (AL16). With no rule, every vendor
 * recorded earned is lost (`rule_off`). A loss names its break when the break came after the vendor was recorded
 * earned; one that came before cannot be why, so the rule changed.
 */
export function earnedChanges(statuses: readonly EarnedStatus[], recorded: ReadonlyMap<string, RecordedStatus>, streak: number | null): EarnedChange[] {
  if (streak === null) {
    return [...recorded].filter(([, record]) => record.state === "earned").map(([vendorId]) => ({ vendorId, to: "lost" as const, because: "rule_off" as const, since: null }));
  }
  const changes: EarnedChange[] = [];
  for (const status of statuses) {
    const record = recorded.get(status.vendorId);
    if (status.state === "earned") {
      if (record?.state !== "earned") changes.push({ vendorId: status.vendorId, to: "earned", status });
      continue;
    }
    if (record?.state !== "earned") continue;
    if (status.state === "cannot") {
      changes.push({ vendorId: status.vendorId, to: "lost", because: status.because, since: null });
    } else if (status.since && time(status.since.at) >= time(record.at)) {
      changes.push({ vendorId: status.vendorId, to: "lost", because: status.since.kind, since: status.since });
    } else {
      changes.push({ vendorId: status.vendorId, to: "lost", because: "rule_changed", since: null });
    }
  }
  return changes;
}

/** `vendor_earned` (AL15): the decisions whose agreed verdicts earned it, newest first, at most 50, and their dates. */
export function earnedVendorEntry(status: EarnedStatusOf<"earned">, streak: number, trigger: EarnedTrigger): LedgerEntryInput {
  const evidence = status.counted.slice(0, EARNED_EVIDENCE_MAX);
  return {
    actor: "system",
    domain: "compliance",
    action: "vendor_earned",
    summary: `${status.name} is an earned vendor: ${status.agreed} agreed verdicts in a row on the agent's decisions to pay it`,
    detail: {
      counterpartyId: status.vendorId,
      streak,
      agreed: status.agreed,
      evidence: evidence.map((decision) => decision.seq),
      from: evidence[evidence.length - 1].at,
      to: evidence[0].at,
      since: status.since,
      trigger,
    },
  };
}

const LOST_WORDS: Record<LostBecause, string> = {
  disagreed: "a person disagreed with a decision on one of its bills",
  flagged: "one of its bills was flagged for review",
  code_stop: "a check in code stopped one of its bills",
  rule_changed: "the rule changed",
  rule_off: "the rule is off",
  high_risk: "it is screened high risk",
  no_payment_limit: "it has no payment limit",
  not_a_vendor: "it is not a vendor",
};

/** `vendor_earned_lost` (AL15, AL16): why, with the decision and rule of a break. */
export function earnedLostEntry(input: { vendorId: string; name: string; streak: number | null; because: LostBecause; since: EarnedBreak | null; trigger: EarnedTrigger }): LedgerEntryInput {
  return {
    actor: "system",
    domain: "compliance",
    action: "vendor_earned_lost",
    summary: `${input.name} is no longer an earned vendor: ${LOST_WORDS[input.because]}`,
    detail: {
      counterpartyId: input.vendorId,
      streak: input.streak,
      because: input.because,
      decisionSeq: input.since?.decisionSeq ?? null,
      rule: input.since?.rule ?? null,
      trigger: input.trigger,
    },
  };
}

/** `earned_vendor_rule_changed`'s summary (AL17). */
export function earnedRuleSummary(to: number | null): string {
  return to === null ? "Earned vendors turned off" : `Earned vendors: ${to} agreed verdicts in a row`;
}

/** `earned_vendor_payments_changed`'s summary (AL21). */
export function earnedPaymentsSummary(to: boolean): string {
  return to ? "The agent pays earned vendors on its own in shadow mode" : "Earned vendors' payments wait for a verdict again";
}

// ---------------------------------------------------------------------------------------------------------------------
// What people read (AL11, AL18, AL19)

/** What the rule does now, in one sentence, for Settings (AL11). */
export function earnedVendorsSentence(streak: number | null): string {
  if (streak === null) return "Off: no vendor is counted as earned.";
  return `On: a vendor is earned after ${streak} agreed verdicts in a row on the agent's decisions to pay or schedule its bills. A disagreement, a bill flagged for review, or a check in code stopping one of its bills starts the count again.`;
}

/** What the switch does now (AL21), under the rule in Settings. */
export const EARNED_PAYMENTS_OFF = "Earned vendors' payments wait for your verdict, as every payment in shadow mode does.";
export const EARNED_PAYMENTS_ON = "The agent pays earned vendors on its own, within every limit and check, and you give your verdict after.";

/**
 * What turning the switch on means, in its confirmation (AL21, AL22, AL26): a payment the agent makes this way moves
 * test USDC on Arc testnet, or is simulated where every payment of the workspace is.
 */
export function earnedPaymentsConfirm(simulated: boolean): string {
  const made = simulated ? "simulated: nothing is sent on chain." : "in test USDC on Arc testnet.";
  return `In shadow mode, a payment to a vendor that earned it under your rule is made without waiting for your verdict, ${made} Every limit and check still applies, and it counts against the agent's spending limit. You give your verdict after, and one disagreement takes the vendor's status away. At most ${EARNED_WAITING_MAX} of a vendor's payments wait for your verdict at once.`;
}

/**
 * What shadow mode pays, as Settings and its toast say it to the owner (shadow mode S1; AL28): nothing until a person
 * agrees, except, while the switch is on, the vendors that earned it, paid on the agent's own decision.
 */
export function shadowModePaysWords(earnedPayments: boolean): string {
  const nothing = "the agent pays nothing until a person agrees";
  return earnedPayments ? `${nothing}, except vendors that earned it under your rule, which it pays on its own and you review after` : nothing;
}

/** The days a run of agreed verdicts spans. */
function span(from: string, to: string): string {
  return utcDay(from) === utcDay(to) ? `on ${utcDay(from)}` : `${utcDay(from)} to ${utcDay(to)}`;
}

/** What started the count again, as the report says it. */
function sinceWords(since: EarnedBreak): string {
  const day = utcDay(since.at);
  if (since.kind === "disagreed") return `since you disagreed on ${day}`;
  if (since.kind === "flagged") return `since a bill was flagged for review on ${day}`;
  const brief = ruleInBrief(since.rule);
  return `since a check in code stopped a bill on ${day}${brief ? `: ${brief}` : ""}`;
}

const CANNOT_WORDS: Record<EarnedStatusOf<"cannot">["because"], string> = {
  high_risk: "Cannot earn it: screened high risk.",
  no_payment_limit: "Cannot earn it: no payment limit. Set one on Counterparties.",
  not_a_vendor: "Cannot earn it: only a vendor can.",
};

/**
 * A vendor's status as the report says it (AL18). Earned only once it is also recorded earned: earned now and not yet
 * signed says when it will be, which is when a sync runs (AL16): after a verdict, or as a stage with bills to decide
 * starts, not at every cycle.
 */
export function earnedStatusWords(status: EarnedStatus, recordedEarned: boolean): string {
  if (status.state === "cannot") return CANNOT_WORDS[status.because];
  if (status.state === "earned") {
    return recordedEarned
      ? `Earned: ${status.agreed} agreed in a row, ${span(status.from, status.to)}`
      : "Earned under your rule. It is recorded at your next verdict, or when the agent next decides a bill.";
  }
  const count = `${status.agreed} of ${status.needed} agreed in a row`;
  return status.since ? `${count} ${sinceWords(status.since)}` : count;
}

/**
 * How many of an earned vendor's payments the agent made on its own wait for your verdict, and, at 3, that its next
 * waits too (AL26); null when none waits.
 */
export function earnedWaitingWords(status: EarnedStatus): string | null {
  if (status.state !== "earned" || status.waiting === 0) return null;
  if (status.paused) return `${status.waiting} of its payments made on its own wait for your verdict, so its next waits for you.`;
  return status.waiting === 1 ? "1 of its payments made on its own waits for your verdict." : `${status.waiting} of its payments made on its own wait for your verdict.`;
}

/** What the report says earning changes, after the rule (AL18, AL28): the switch on, or what would let the agent pay. */
export function earnedChangesWords(payments: boolean): string {
  return payments
    ? "The agent pays an earned vendor on its own, and you give your verdict after."
    : "Earning changes nothing the agent may do unless an owner lets it pay earned vendors on its own, in Settings.";
}

/** The report's view of the rule (AL18): the rule, the switch, every vendor's status, and the vendors recorded earned. */
export interface EarnedVendorsView {
  streak: number | null;
  /** The owner's switch (AL21); absent reads as off. */
  payments?: boolean;
  statuses: EarnedStatus[];
  recorded: ReadonlySet<string>;
}

/** The vendors shown as earned: earned now and recorded earned (AL18, AL19). */
export function shownEarned(view: EarnedVendorsView): Set<string> {
  if (view.streak === null) return new Set();
  return new Set(view.statuses.filter((status) => status.state === "earned" && view.recorded.has(status.vendorId)).map((status) => status.vendorId));
}
