import { AGENT_DECISION_ACTIONS } from "../agent/shadow-hold";
import { payToDiffers } from "../invoice-pay-to-rules";

/**
 * The shadow-mode decisions the Quality Lab replays, exported from the team's own workspaces into a committed file
 * (docs/superpowers/specs/2026-10-26-quality-lab-shadow-replay-design.md SX1-SX8). Pure: `npm run quality-lab:shadow`
 * (scripts/quality-lab-shadow.ts) hands it the rows it read, and writes what this returns once `assertShareable` passes.
 *
 * Built on an allowlist (SX3): every field of a decision's ledger detail that reaches the file is named below, one by
 * one, and passes only as a number, a boolean or an enum-like token. Everything else is dropped, so a field the ledger
 * gains later never reaches this public file until someone names it here. No text, name, reference, address, email,
 * id, hash or ledger number is kept (SX4): ids that link decisions become pseudonyms local to the file, and dates
 * become days from the decision's own day (SX5).
 */

/** Where the script writes the file, from the repository's root. */
export const SHADOW_DECISIONS_PATH = "src/lib/quality-lab/shadow-decisions.json";

/** What the file is, in its own words (SX8). */
export const SHADOW_DECISIONS_SOURCE =
  "Every decision the agent made on a bill in shadow mode in the Vestiarion team's own workspaces on Arc testnet, with " +
  "the person's verdict on each. Customers' workspaces are never exported.";

export type ShadowAction = "pay" | "schedule" | "hold" | "flag_fraud" | "request_info";
export type ShadowVerdict = "agree" | "disagree";

/** The decision as its entry records it, after code bounded its date; `timingRule` says when code moved it. */
export interface ShadowDecisionTaken {
  action: ShadowAction;
  /** A schedule's day, in days from the decision's day; null for any other action. */
  payOnInDays: number | null;
  fundWithSwap: boolean | null;
  confidence: number | null;
}

/** The timing figures the decision was made with (`timing`), dates as days from the decision's day. */
export interface ShadowTiming {
  dueInDays: number | null;
  targetInDays: number | null;
  recommendation: { action: string | null; payOnInDays: number | null } | null;
  discountValue: number | null;
  discountAvailableUntilInDays: number | null;
  floatValueToDue: number | null;
  shortfall: boolean | null;
  amountDueAtTarget: number | null;
  earlierObligations: { total: number | null; count: number | null } | null;
}

export interface ShadowTerms {
  earlyPayDiscount: { percent: number | null; deadlineInDays: number | null } | null;
  lateFee: { kind: string | null; value: number | null; startsOnInDays: number | null; aMonth: number | null } | null;
}

export interface ShadowBudget {
  dailyUsdc: number | null;
  weeklyUsdc: number | null;
  spentToday: number | null;
  spentThisWeek: number | null;
  remaining: number | null;
  binding: string | null;
}

/** The spending limit contract's coverage and verdict, without the contract's or the agent's address or the ref. */
export interface ShadowOnChainLimit {
  covered: boolean | null;
  uncoveredBecause: string | null;
  verdict: { state: string | null; error: string | null; spent: number | null; amount: number | null; limit: number | null } | null;
}

export interface ShadowCashAhead {
  scheduledForInDays: number | null;
  cashCounted: number | null;
  dueBefore: { total: number | null; count: number | null } | null;
  needed: number | null;
}

/** The new payee check (`observed.newPayee`): who stands behind the address by kind, never by member. */
export interface ShadowNewPayee {
  /** `member` for a member's id, or the check's own `payee` or `mirror`. */
  addressBy: "member" | "payee" | "mirror" | null;
  askedVia: "payee_link" | "github" | null;
  confirmed: boolean;
  unanswered: boolean;
  twoParties: boolean | null;
}

export interface ShadowPerformance {
  score: number | null;
  status: string | null;
  inputs: {
    paidWithoutIntervention: number | null;
    informationRequested: number | null;
    heldOrFlagged: number | null;
    duplicateSubmissions: number | null;
    riskTierChanges: number | null;
    heldByOurPolicy: number | null;
  } | null;
}

/** The project's reservation (`observed.project`), its figures in minor units, without its id or name. */
export interface ShadowProjectCheck {
  state: string | null;
  already: boolean | null;
  neededMinor: number | null;
  budgetMinor: number | null;
  bufferMinor: number | null;
  reservedMinor: number | null;
  paidMinor: number | null;
  availableMinor: number | null;
}

export interface ShadowDuplicateMatch {
  /** The other bill's pseudonym: the same one it has where it is decided itself. */
  otherBill: string | null;
  otherInvoiceStatus: string | null;
  confidence: number | null;
  signals: string[];
}

export interface ShadowObserved {
  amount: number | null;
  paymentLimit: number | null;
  riskLevel: string | null;
  performanceHistory: ShadowPerformance | null;
  /** Whether the bill had a purchase order; never the reference itself. */
  poPresent: boolean;
  goodsReceived: boolean | null;
  purchaseOrderRequired: boolean | null;
  twoApprovalsAbove: number | null;
  newPayee: ShadowNewPayee | null;
  addressHistory: { workspacesPaid: number | null; paymentsConfirmed: number | null; priceUsdc: number | null } | null;
  operatingBalance: number | null;
  addressUnconfirmed: boolean | null;
  addressMissing: boolean;
  /** Whether the bill's document named an address to pay, and whether it differs from the one on file at export. */
  documentPayTo: { present: boolean; differs: boolean };
  /** The project's pseudonym, or null for a bill in none. */
  projectId: string | null;
  project: ShadowProjectCheck | null;
  sameWork: Array<{ otherKind: string | null; other: string | null; otherStatus: string | null; signal: string | null }>;
  duplicateCheck: { candidatesConsidered: number | null; matchesTotal: number | null; matchesShown: number | null; matches: ShadowDuplicateMatch[] } | null;
}

/** One exported decision. Pseudonyms (`w1`, `b1`, `p1`, `pj1`, `m1`) are local to the file and stable within it. */
export interface ShadowDecision {
  /** `shadow-01`, `shadow-02`, ... in the order the decisions were made. */
  id: string;
  /** When it was decided, to the minute (ISO, UTC). */
  decidedAt: string;
  workspace: string;
  bill: string | null;
  payee: string | null;
  /** The person's verdict, or null when none was given. Never its reason. */
  verdict: ShadowVerdict | null;
  decision: ShadowDecisionTaken;
  decisionMode: string | null;
  /** The written policy's action (`referenceDecision.action`). */
  referenceAction: string | null;
  agreedWithReference: boolean | null;
  guardrailBlocked: boolean | null;
  guardrailRule: string | null;
  currency: string | null;
  timingRule: string | null;
  /** The day the model asked for when code moved it, in days from the decision's day. */
  requestedPayOnInDays: number | null;
  /** The day an earlier cycle had scheduled the bill for, in days from the decision's day. */
  scheduledForInDays: number | null;
  timing: ShadowTiming | null;
  terms: ShadowTerms | null;
  outflowBudget: ShadowBudget | null;
  onChainLimit: ShadowOnChainLimit | null;
  /** Who sent the vendor's document the bill's purchase order came from (`vendor` or `member`), or null for none. */
  vendorDocument: string | null;
  paidToBank: boolean;
  payout: { chain: string | null; route: string | null; feeUsdc: number | null } | null;
  eurc: { usdcValue: number | null; fxRate: number | null; eurcBalance: number | null } | null;
  cashAhead: ShadowCashAhead | null;
  cashPriority: { waits: boolean | null; byPerson: boolean } | null;
  reevaluation: { trigger: string | null; previousAction: string | null } | null;
  amountPaid: number | null;
  discountTaken: number | null;
  observed: ShadowObserved;
  execution: { resultingStatus: string | null; heldBecause: string | null };
}

export interface ShadowDecisionsFile {
  source: string;
  /** When the export read the database (ISO). */
  readAt: string;
  decisions: ShadowDecision[];
}

/** One ledger entry as the script reads it (scripts/lib/quality-lab-shadow.ts `SHADOW_ENTRIES_SQL`). */
export interface ShadowLedgerRow {
  seq: string | number | bigint;
  ts: Date | string;
  org_id: string;
  action: string;
  /** `ours` or `customers`, as open_verdicts (0086) splits workspaces: the export refuses any but `ours` (SX2). */
  side: string;
  detail: unknown;
  /** The payee's address on file at export, read only to tell whether a document's pay-to differs (SX4); never kept. */
  address_on_file: string | null;
}

/** One verdict as the script reads it: never its reason. */
export interface ShadowVerdictRow {
  org_id: string;
  entry_seq: string | number | bigint;
  verdict: string;
}

type Detail = Record<string, unknown>;

const DAY_MS = 86_400_000;
const TOKEN = /^[a-z][a-z0-9_.-]{0,39}$/;
const CURRENCY = /^[A-Z]{3,5}$/;
const ACTIONS: ReadonlySet<string> = new Set(AGENT_DECISION_ACTIONS);

function record(value: unknown): Detail | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Detail) : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A finite number, or a numeric string as Postgres's numeric arrives; anything else is null. */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** An enum-like value: lowercase letters, digits, `_`, `.` and `-`, at most 40 characters. Free text never is one. */
function token(value: unknown): string | null {
  return typeof value === "string" && TOKEN.test(value) ? value : null;
}

/** The UTC day of a `YYYY-MM-DD` date or a timestamp, or null. */
function dayOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ? null : value;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString().slice(0, 10);
}

/** Whole UTC days from `day` to the date `value` names, negative when before; null when it names none (SX5). */
function daysFrom(day: string, value: unknown): number | null {
  const other = dayOf(value);
  if (other === null) return null;
  return Math.round((Date.parse(`${other}T00:00:00.000Z`) - Date.parse(`${day}T00:00:00.000Z`)) / DAY_MS);
}

/** Pseudonyms local to the file, assigned in the order they are first met (SX4). */
class Pseudonyms {
  private readonly names = new Map<string, Map<string, string>>();

  of(prefix: string, id: unknown): string | null {
    if (typeof id !== "string" || id.trim() === "") return null;
    let names = this.names.get(prefix);
    if (!names) {
      names = new Map();
      this.names.set(prefix, names);
    }
    const key = id.trim().toLowerCase();
    let name = names.get(key);
    if (!name) {
      name = `${prefix}${names.size + 1}`;
      names.set(key, name);
    }
    return name;
  }
}

function timingOf(day: string, value: unknown): ShadowTiming | null {
  const timing = record(value);
  if (!timing) return null;
  const recommendation = record(timing.recommendation);
  const earlier = record(timing.earlierObligations);
  return {
    dueInDays: daysFrom(day, timing.dueOn),
    targetInDays: daysFrom(day, timing.targetOn),
    recommendation: recommendation ? { action: token(recommendation.action), payOnInDays: daysFrom(day, recommendation.payOn) } : null,
    discountValue: num(timing.discountValue),
    discountAvailableUntilInDays: daysFrom(day, timing.discountAvailableUntil),
    floatValueToDue: num(timing.floatValueToDue),
    shortfall: bool(timing.shortfall),
    amountDueAtTarget: num(timing.amountDueAtTarget),
    earlierObligations: earlier ? { total: num(earlier.total), count: num(earlier.count) } : null,
  };
}

function termsOf(day: string, value: unknown): ShadowTerms | null {
  const terms = record(value);
  if (!terms) return null;
  const discount = record(terms.earlyPayDiscount);
  const lateFee = record(terms.lateFee);
  return {
    earlyPayDiscount: discount ? { percent: num(discount.percent), deadlineInDays: daysFrom(day, discount.deadline) } : null,
    lateFee: lateFee
      ? { kind: token(lateFee.kind), value: num(lateFee.value), startsOnInDays: daysFrom(day, lateFee.startsOn), aMonth: num(lateFee.aMonth) }
      : null,
  };
}

function budgetOf(value: unknown): ShadowBudget | null {
  const budget = record(value);
  if (!budget) return null;
  return {
    dailyUsdc: num(budget.dailyUsdc),
    weeklyUsdc: num(budget.weeklyUsdc),
    spentToday: num(budget.spentToday),
    spentThisWeek: num(budget.spentThisWeek),
    remaining: num(budget.remaining),
    binding: token(budget.binding),
  };
}

function onChainLimitOf(value: unknown): ShadowOnChainLimit | null {
  const limit = record(value);
  if (!limit) return null;
  const verdict = record(limit.verdict);
  return {
    covered: bool(limit.covered),
    uncoveredBecause: token(limit.uncoveredBecause),
    verdict: verdict
      ? { state: token(verdict.state), error: typeof verdict.error === "string" && /^[A-Za-z]{1,40}$/.test(verdict.error) ? verdict.error : null, spent: num(verdict.spent), amount: num(verdict.amount), limit: num(verdict.limit) }
      : null,
  };
}

function newPayeeOf(value: unknown): ShadowNewPayee | null {
  const check = record(value);
  if (!check) return null;
  const by = check.addressBy;
  return {
    addressBy: by === "payee" || by === "mirror" ? by : typeof by === "string" && by !== "" ? "member" : null,
    askedVia: typeof check.linkCreatedBy === "string" ? "payee_link" : typeof check.bountyBy === "string" ? "github" : null,
    confirmed: typeof check.confirmedBy === "string" && check.confirmedBy !== "",
    unanswered: check.unanswered === true,
    twoParties: bool(check.twoParties),
  };
}

function performanceOf(value: unknown): ShadowPerformance | null {
  const performance = record(value);
  if (!performance) return null;
  const inputs = record(performance.inputs);
  return {
    score: num(performance.score),
    status: token(performance.status),
    inputs: inputs
      ? {
          paidWithoutIntervention: num(inputs.paidWithoutIntervention),
          informationRequested: num(inputs.informationRequested),
          heldOrFlagged: num(inputs.heldOrFlagged),
          duplicateSubmissions: num(inputs.duplicateSubmissions),
          riskTierChanges: num(inputs.riskTierChanges),
          heldByOurPolicy: num(inputs.heldByOurPolicy),
        }
      : null,
  };
}

function projectOf(value: unknown): ShadowProjectCheck | null {
  const project = record(value);
  if (!project) return null;
  return {
    state: token(project.state),
    already: bool(project.already),
    neededMinor: num(project.neededMinor),
    budgetMinor: num(project.budgetMinor),
    bufferMinor: num(project.bufferMinor),
    reservedMinor: num(project.reservedMinor),
    paidMinor: num(project.paidMinor),
    availableMinor: num(project.availableMinor),
  };
}

function observedOf(value: unknown, addressOnFile: string | null, names: Pseudonyms): ShadowObserved {
  const observed = record(value) ?? {};
  const history = record(observed.addressHistory);
  const duplicates = record(observed.duplicateCheck);
  const payTo = typeof observed.documentPayTo === "string" && observed.documentPayTo !== "" ? observed.documentPayTo : null;
  // Pseudonyms in a fixed order within the decision: its project, then the bills and milestones it names.
  const projectId = names.of("pj", observed.projectId ?? record(observed.project)?.id);
  const matches = list(duplicates?.matches)
    .map(record)
    .filter((match): match is Detail => match !== null)
    .map((match) => ({
      otherBill: names.of("b", match.otherInvoiceId),
      otherInvoiceStatus: token(match.otherInvoiceStatus),
      confidence: num(match.confidence),
      signals: list(match.signals).map(token).filter((signal): signal is string => signal !== null),
    }));
  const sameWork = list(observed.sameWork)
    .map(record)
    .filter((match): match is Detail => match !== null)
    .map((match) => {
      const otherKind = token(match.otherKind);
      return {
        otherKind,
        other: otherKind === "bill" ? names.of("b", match.otherId) : otherKind === "milestone" ? names.of("m", match.otherId) : null,
        otherStatus: token(match.otherStatus),
        signal: token(match.signal),
      };
    });
  return {
    amount: num(observed.amount),
    paymentLimit: num(observed.paymentLimit),
    riskLevel: token(observed.riskLevel),
    performanceHistory: performanceOf(observed.performanceHistory),
    poPresent: typeof observed.poReference === "string" && observed.poReference.trim() !== "",
    goodsReceived: bool(observed.goodsReceived),
    purchaseOrderRequired: bool(observed.purchaseOrderRequired),
    twoApprovalsAbove: num(observed.twoApprovalsAbove),
    newPayee: newPayeeOf(observed.newPayee),
    addressHistory: history ? { workspacesPaid: num(history.workspacesPaid), paymentsConfirmed: num(history.paymentsConfirmed), priceUsdc: num(history.priceUsdc) } : null,
    operatingBalance: num(observed.operatingBalance),
    addressUnconfirmed: bool(observed.addressUnconfirmed),
    addressMissing: observed.addressMissing === true,
    documentPayTo: { present: payTo !== null, differs: payToDiffers(payTo, addressOnFile) },
    projectId,
    project: projectOf(observed.project),
    sameWork,
    duplicateCheck: duplicates
      ? { candidatesConsidered: num(duplicates.candidatesConsidered), matchesTotal: num(duplicates.matchesTotal), matchesShown: num(duplicates.matchesShown), matches }
      : null,
  };
}

function decisionOf(row: ShadowLedgerRow, detail: Detail, day: string, names: Pseudonyms, verdict: ShadowVerdict | null, id: string): ShadowDecision {
  const decision = record(detail.decision) ?? {};
  const fromLedger = row.action.slice("ap_".length) as ShadowAction;
  const action = typeof decision.action === "string" && `ap_${decision.action}` === row.action ? (decision.action as ShadowAction) : fromLedger;
  const payout = record(detail.payout);
  const fx = record(detail.fx);
  const isEurc = "usdcValue" in detail || "eurcBalance" in detail;
  const cashAhead = record(detail.cashAhead);
  const dueBefore = record(cashAhead?.dueBefore);
  const cashPriority = record(detail.cashPriority);
  const reevaluation = record(detail.reevaluation);
  const execution = record(detail.execution) ?? {};
  // Pseudonyms in a fixed order: the workspace, the bill, the payee, then what the observed facts name.
  const workspace = names.of("w", row.org_id) as string;
  const bill = names.of("b", detail.invoiceId);
  const payee = names.of("p", detail.counterpartyId);
  return {
    id,
    decidedAt: `${new Date(row.ts).toISOString().slice(0, 16)}:00.000Z`,
    workspace,
    bill,
    payee,
    verdict,
    decision: {
      action,
      payOnInDays: daysFrom(day, decision.payOn),
      fundWithSwap: bool(decision.fundWithSwap),
      confidence: num(decision.confidence),
    },
    decisionMode: token(detail.decisionMode),
    referenceAction: token(record(detail.referenceDecision)?.action),
    agreedWithReference: bool(detail.agreedWithReference),
    guardrailBlocked: bool(detail.guardrailBlocked),
    guardrailRule: token(detail.guardrailRule),
    currency: typeof detail.currency === "string" && CURRENCY.test(detail.currency) ? detail.currency : null,
    timingRule: token(detail.timingRule),
    requestedPayOnInDays: daysFrom(day, detail.requestedPayOn),
    scheduledForInDays: daysFrom(day, detail.scheduledFor),
    timing: timingOf(day, detail.timing),
    terms: termsOf(day, detail.terms),
    outflowBudget: budgetOf(detail.outflowBudget),
    onChainLimit: onChainLimitOf(detail.onChainLimit),
    vendorDocument: token(record(detail.vendorDocument)?.source),
    paidToBank: detail.paidToBank === true,
    payout: payout ? { chain: token(payout.chain), route: token(payout.route), feeUsdc: num(payout.feeUsdc) } : null,
    eurc: isEurc ? { usdcValue: num(detail.usdcValue), fxRate: num(fx?.rate), eurcBalance: num(detail.eurcBalance) } : null,
    cashAhead: cashAhead
      ? {
          scheduledForInDays: daysFrom(day, cashAhead.scheduledFor),
          cashCounted: num(cashAhead.cashCounted),
          dueBefore: dueBefore ? { total: num(dueBefore.total), count: num(dueBefore.count) } : null,
          needed: num(cashAhead.needed),
        }
      : null,
    cashPriority: cashPriority ? { waits: bool(cashPriority.waits), byPerson: cashPriority.byPerson === true } : null,
    reevaluation: reevaluation ? { trigger: token(reevaluation.trigger), previousAction: token(reevaluation.previousAction) } : null,
    amountPaid: num(detail.amountPaid),
    discountTaken: num(detail.discountTaken),
    observed: observedOf(detail.observed, row.address_on_file, names),
    execution: { resultingStatus: token(execution.resultingStatus), heldBecause: token(execution.heldBecause) },
  };
}

function seqOf(value: string | number | bigint): bigint {
  return BigInt(typeof value === "number" ? Math.trunc(value) : value);
}

/** Whether the entry is one SX1 exports: an agent decision on a bill, made in shadow mode, not the guardrail fixture's. */
function exportable(row: ShadowLedgerRow): Detail | null {
  const detail = record(row.detail);
  if (!detail || !ACTIONS.has(row.action)) return null;
  if (detail.shadow !== true && detail.shadow !== "true") return null;
  if ("guardrailFixture" in detail) return null;
  return detail;
}

/**
 * The file the script writes (SX3-SX5, SX8): the exportable rows in time order, the ledger's order breaking a tie, each
 * through the allowlist, with its verdict. Throws when any row is a customer's (SX2), whatever else it holds.
 */
export function exportShadowDecisions(rows: readonly ShadowLedgerRow[], verdicts: readonly ShadowVerdictRow[], readAt: Date): ShadowDecisionsFile {
  if (rows.some((row) => row.side !== "ours")) {
    throw new Error("A customer's workspace reached the shadow export: nothing is exported (shadow replay SX2)");
  }
  const given = new Map<string, ShadowVerdict>();
  for (const row of verdicts) {
    if (row.verdict === "agree" || row.verdict === "disagree") given.set(`${row.org_id}:${seqOf(row.entry_seq)}`, row.verdict);
  }
  const kept = rows
    .map((row) => ({ row, detail: exportable(row), at: new Date(row.ts).getTime(), seq: seqOf(row.seq) }))
    .filter((entry): entry is { row: ShadowLedgerRow; detail: Detail; at: number; seq: bigint } => entry.detail !== null && Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at || (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  const width = Math.max(2, String(kept.length).length);
  const names = new Pseudonyms();
  const decisions = kept.map(({ row, detail, at, seq }, index) =>
    decisionOf(row, detail, new Date(at).toISOString().slice(0, 10), names, given.get(`${row.org_id}:${seq}`) ?? null, `shadow-${String(index + 1).padStart(width, "0")}`)
  );
  return { source: SHADOW_DECISIONS_SOURCE, readAt: readAt.toISOString(), decisions };
}

const ADDRESS_OR_HASH = /0x[0-9a-f]{40}/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONGEST = 40;

/** Why a string may not be published, or null when it may (SX6). */
function unshareable(value: string): string | null {
  if (ADDRESS_OR_HASH.test(value)) return "looks like an address or a hash";
  if (EMAIL.test(value)) return "looks like an email address";
  if (UUID.test(value)) return "looks like a UUID";
  if (value.length > LONGEST) return `is longer than ${LONGEST} characters`;
  return null;
}

function refuse(path: string, why: string): never {
  throw new Error(`The shadow export is refused: ${path} ${why}. Nothing is written (shadow replay SX6)`);
}

function walk(value: unknown, path: string): void {
  if (typeof value === "string") {
    const why = unshareable(value);
    if (why) refuse(path, why);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      // A key is named by its parent's path only, so the refusal never repeats what it refused.
      const why = unshareable(key);
      if (why) refuse(path, `has a key that ${why}`);
      walk(item, path === "" ? key : `${path}.${key}`);
    }
  }
}

/**
 * Refuses the whole file, naming the path of the first offending value and never the value, when any key or string in
 * its decisions or its time looks like an address or hash, an email address or a UUID, or is longer than 40 characters,
 * or when its source is not this module's own sentence (SX6). The script calls it before writing.
 */
export function assertShareable(file: ShadowDecisionsFile): void {
  if (file.source !== SHADOW_DECISIONS_SOURCE) refuse("source", "is not the export's own sentence");
  walk({ readAt: file.readAt, decisions: file.decisions }, "");
}
