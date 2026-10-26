import { AGENT_DECISION_ACTIONS } from "../agent/shadow-hold";
import { FOUNDING_ORG_ID } from "../dal/org-config";
import { NO_SWAP_ROUTE, SWAP_NOT_QUOTED, SWAP_QUOTE_UNANSWERED, SWAP_QUOTE_UNREADABLE, swapUnavailableForFx } from "../fx/swap-service";
import { payToDiffers } from "../invoice-pay-to-rules";
import { COOLING_HOURS_MAX } from "../payee-lock-rules";

/**
 * The shadow-mode decisions the Quality Lab replays, exported from the team's own workspaces into a committed file
 * (docs/superpowers/specs/2026-10-26-quality-lab-shadow-replay-design.md SX1-SX10). Pure: `npm run quality-lab:shadow`
 * (scripts/quality-lab-shadow.ts) hands it the rows it read, and writes what this returns once `assertShareable` passes.
 *
 * Built on an allowlist (SX3): every field of a decision's ledger detail that reaches the file is named below, one by
 * one, and passes only as a number, a boolean or an enum-like token. Everything else is dropped, so a field the ledger
 * gains later never reaches this public file until someone names it here. No text, name, reference, address, email,
 * id, hash or ledger number is kept (SX4): ids that link decisions become pseudonyms local to the file, and dates
 * become days from the day the decision measured its timing on (SX5).
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
  /**
   * Whether the bill's document named an address to pay, and whether it differed from the one on file at the decision:
   * true when the decision was held for exactly that (`invoice.pay_to_differs`), else measured against the address on
   * file at export when it has not changed since the decision, else null (unknown).
   */
  documentPayTo: { present: boolean; differs: boolean | null };
  /** The project's pseudonym, or null for a bill in none. */
  projectId: string | null;
  project: ShadowProjectCheck | null;
  sameWork: Array<{ otherKind: string | null; other: string | null; otherStatus: string | null; signal: string | null }>;
  duplicateCheck: { candidatesConsidered: number | null; matchesTotal: number | null; matchesShown: number | null; matches: ShadowDuplicateMatch[] } | null;
}

/**
 * What the payee's row says of the decision, read beside its entry (SX3): its role, which nothing changes once the payee
 * is added, and when its address last changed as whole hours before the decision, which the cooling-off weighs. That
 * time is known only while the address has not changed since; otherwise both are as unknown as they say.
 */
export interface ShadowPayeeOnFile {
  /** `vendor`, `client` or `contractor`. */
  role: string | null;
  /** Whole hours from the address's last change to the decision; null when it never changed, or changed since. */
  addressChangedHoursBefore: number | null;
  /** Whether the address changed after the decision, or the read could not say: then the hours are unknown. */
  addressChangedSinceDecision: boolean;
}

/**
 * The workspace's payee lock in force when the decision was made (SX9), which `counterparty.cooling_off` weighs with
 * `payeeOnFile.addressChangedHoursBefore`: from the workspace's signed ledger, never from who changed it.
 */
export interface ShadowPayeeLock {
  on: boolean;
  /** Hours a changed address waits before it is paid, 0 to 168; kept while the lock is off, applied only once it is on. */
  coolingHours: number;
}

/** The EURC figures a EURC bill was weighed with, and the swap it was offered or why there was none. */
export interface ShadowEurc {
  usdcValue: number | null;
  fxRate: number | null;
  /** The least USDC the FX quote would give (`fx.usdcMinimum`). */
  usdcMinimum: number | null;
  eurcBalance: number | null;
  usdcDueWithin7Days: number | null;
  swapOffer: { usdcIn: number | null; costPercent: number | null; eurcMinimum: number | null } | null;
  /** Why no swap was offered, as a kind (`swapUnavailableKind`), never the sentence. */
  swapUnavailable: string | null;
}

/** One exported decision. Pseudonyms (`w1`, `b1`, `p1`, `pj1`, `m1`) are local to the file and stable within it. */
export interface ShadowDecision {
  /** `shadow-01`, `shadow-02`, ... in the order the decisions were made. */
  id: string;
  /** When its entry was written, to the minute (ISO, UTC). */
  decidedAt: string;
  /**
   * The UTC day every `…InDays` counts from (SX5): the day the decision code measured its timing on (`timing.today`), or
   * the day of `decidedAt` when the entry records none. A cycle that crosses midnight writes its entry the day after.
   */
  decidedOn: string;
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
  /** A payee on another chain: the route, its fee, the Gateway balance a Gateway payout was weighed against, both quotes. */
  payout: {
    chain: string | null;
    route: string | null;
    feeUsdc: number | null;
    gatewayBalanceUsdc: number | null;
    quotes: { cctpFeeUsdc: number | null; gatewayFeeUsdc: number | null } | null;
  } | null;
  eurc: ShadowEurc | null;
  cashAhead: ShadowCashAhead | null;
  cashPriority: { waits: boolean | null; byPerson: boolean } | null;
  reevaluation: { trigger: string | null; previousAction: string | null } | null;
  amountPaid: number | null;
  discountTaken: number | null;
  observed: ShadowObserved;
  payeeOnFile: ShadowPayeeOnFile;
  /** The payee lock in force at the decision, or null when the ledger cannot account for it (SX9): unknown, never off. */
  payeeLock: ShadowPayeeLock | null;
  /** `chainMode` is `live` or `simulate`. */
  execution: { resultingStatus: string | null; heldBecause: string | null; chainMode: string | null };
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
  /**
   * `founding` (the founding workspace, by its id), `team` (one a platform team member created) or `customers`: the
   * export refuses the whole file for any other, and for `founding` on any workspace but the founding one (SX2).
   */
  side: string;
  detail: unknown;
  /** The payee's address on file at export, read only to tell whether a document's pay-to differs (SX4); never kept. */
  address_on_file: string | null;
  /** Whether the payee's address changed after the decision; anything but false is taken as unknown. */
  address_changed_since: boolean | null;
  /** Whole hours from the address's last change to the decision, when it changed at or before it. */
  address_changed_hours_before: number | string | null;
  /** The payee's role. */
  payee_role: string | null;
  /** Whether the payee lock was on at the decision, as the ledger accounts for it (SX9); null when it cannot. */
  payee_lock_on: boolean | null;
  /** Its wait in hours, as Postgres's numeric arrives (a string from `pg`); null when the ledger cannot account for it. */
  payee_lock_cooling_hours: number | string | null;
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

/**
 * The day a decision's dates count from (SX5): the day its timing was measured on (`timing.today`, the decision code's
 * `now`, taken before the model's answer and the checks), when that is a real calendar day within a day of the entry's;
 * the entry's own day otherwise.
 */
function anchorDay(detail: Detail, at: number): string {
  const written = new Date(at).toISOString().slice(0, 10);
  const today = record(detail.timing)?.today;
  if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return written;
  const measured = Date.parse(`${today}T00:00:00.000Z`);
  if (Number.isNaN(measured) || new Date(measured).toISOString().slice(0, 10) !== today) return written;
  return Math.abs(daysFrom(written, today) ?? Number.POSITIVE_INFINITY) <= 1 ? today : written;
}

/**
 * Why a EURC bill was offered no swap, as a kind (`swapUnavailable` records a sentence, src/lib/fx/swap-service.ts and
 * the AP stage's own): Circle's answers by name, the swap's minimum short of the need, a payment already started (or
 * unreadable, which counts as started), and `other` for any sentence not known here. Never the sentence.
 */
function swapUnavailableKind(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  if (value === NO_SWAP_ROUTE) return "no_route";
  if (value === SWAP_QUOTE_UNREADABLE) return "quote_unreadable";
  if (value === SWAP_QUOTE_UNANSWERED) return "quote_unanswered";
  if (value === SWAP_NOT_QUOTED) return "not_quoted";
  if (swapUnavailableForFx(value)) return "minimum_short";
  if (/\ba payment for this invoice\b/i.test(value)) return "payment_started";
  return "other";
}

const ROLES: ReadonlySet<string> = new Set(["vendor", "client", "contractor"]);

function payeeOnFileOf(row: ShadowLedgerRow): ShadowPayeeOnFile {
  // Anything but a plain false is unknown: a time that cannot be shown to be the decision's is never kept.
  const since = row.address_changed_since !== false;
  const hours = num(row.address_changed_hours_before);
  return {
    role: typeof row.payee_role === "string" && ROLES.has(row.payee_role) ? row.payee_role : null,
    addressChangedHoursBefore: !since && hours !== null && Number.isInteger(hours) && hours >= 0 ? hours : null,
    addressChangedSinceDecision: since,
  };
}

/**
 * The payee lock as the read found it in force at the decision (SX9): a boolean and whole hours within the setting's
 * bounds, or null. Anything else, a read that could not account for it included, is unknown, never taken as off.
 */
function payeeLockOf(row: ShadowLedgerRow): ShadowPayeeLock | null {
  const hours = num(row.payee_lock_cooling_hours);
  if (typeof row.payee_lock_on !== "boolean" || hours === null || !Number.isInteger(hours) || hours < 0 || hours > COOLING_HOURS_MAX) return null;
  return { on: row.payee_lock_on, coolingHours: hours };
}

/**
 * Whether the document's pay-to differed from the address on file at the decision (SX4): it did when the decision was
 * held for exactly that; it never did when the document named none; otherwise it is measured against the address on
 * file at export, but only when that address has not changed since the decision, and is unknown when it has.
 */
function payToDiffered(payTo: string | null, row: ShadowLedgerRow, guardrailRule: string | null): boolean | null {
  if (payTo === null) return false;
  if (guardrailRule === "invoice.pay_to_differs") return true;
  if (row.address_changed_since !== false) return null;
  return payToDiffers(payTo, row.address_on_file);
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

function observedOf(value: unknown, row: ShadowLedgerRow, guardrailRule: string | null, names: Pseudonyms): ShadowObserved {
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
    documentPayTo: { present: payTo !== null, differs: payToDiffered(payTo, row, guardrailRule) },
    projectId,
    project: projectOf(observed.project),
    sameWork,
    duplicateCheck: duplicates
      ? { candidatesConsidered: num(duplicates.candidatesConsidered), matchesTotal: num(duplicates.matchesTotal), matchesShown: num(duplicates.matchesShown), matches }
      : null,
  };
}

function eurcOf(detail: Detail): ShadowEurc | null {
  if (!("usdcValue" in detail || "eurcBalance" in detail)) return null;
  const fx = record(detail.fx);
  const offer = record(detail.swapOffer);
  return {
    usdcValue: num(detail.usdcValue),
    fxRate: num(fx?.rate),
    usdcMinimum: num(fx?.usdcMinimum),
    eurcBalance: num(detail.eurcBalance),
    usdcDueWithin7Days: num(detail.usdcDueWithin7Days),
    swapOffer: offer ? { usdcIn: num(offer.usdcIn), costPercent: num(offer.costPercent), eurcMinimum: num(offer.eurcMinimum) } : null,
    swapUnavailable: swapUnavailableKind(detail.swapUnavailable),
  };
}

function payoutOf(value: unknown): ShadowDecision["payout"] {
  const payout = record(value);
  if (!payout) return null;
  const quotes = record(payout.quotes);
  return {
    chain: token(payout.chain),
    route: token(payout.route),
    feeUsdc: num(payout.feeUsdc),
    gatewayBalanceUsdc: num(payout.gatewayBalanceUsdc),
    quotes: quotes ? { cctpFeeUsdc: num(quotes.cctpFeeUsdc), gatewayFeeUsdc: num(quotes.gatewayFeeUsdc) } : null,
  };
}

function decisionOf(row: ShadowLedgerRow, detail: Detail, day: string, names: Pseudonyms, verdict: ShadowVerdict | null, id: string): ShadowDecision {
  const decision = record(detail.decision) ?? {};
  const fromLedger = row.action.slice("ap_".length) as ShadowAction;
  const action = typeof decision.action === "string" && `ap_${decision.action}` === row.action ? (decision.action as ShadowAction) : fromLedger;
  const guardrailRule = token(detail.guardrailRule);
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
    decidedOn: day,
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
    guardrailRule,
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
    payout: payoutOf(detail.payout),
    eurc: eurcOf(detail),
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
    observed: observedOf(detail.observed, row, guardrailRule, names),
    payeeOnFile: payeeOnFileOf(row),
    payeeLock: payeeLockOf(row),
    execution: { resultingStatus: token(execution.resultingStatus), heldBecause: token(execution.heldBecause), chainMode: token(execution.chainMode) },
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
 * Whether a row is the team's own (SX2): a team member's workspace, or the founding one by its own id. A workspace with
 * no creator is neither: its creator deleted their account (0023), and it may be a former customer's (0037).
 */
function ours(row: ShadowLedgerRow): boolean {
  return row.side === "team" || (row.side === "founding" && row.org_id === FOUNDING_ORG_ID);
}

/**
 * The file the script writes (SX3-SX5, SX8): the exportable rows in time order, the ledger's order breaking a tie, each
 * through the allowlist, with its verdict. Throws when any row is not the team's own (SX2), whatever else it holds.
 */
export function exportShadowDecisions(rows: readonly ShadowLedgerRow[], verdicts: readonly ShadowVerdictRow[], readAt: Date): ShadowDecisionsFile {
  if (!rows.every(ours)) {
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
    decisionOf(row, detail, anchorDay(detail, at), names, given.get(`${row.org_id}:${seq}`) ?? null, `shadow-${String(index + 1).padStart(width, "0")}`)
  );
  return { source: SHADOW_DECISIONS_SOURCE, readAt: readAt.toISOString(), decisions };
}

const ADDRESS_OR_HASH = /0x[0-9a-f]{40}/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** 32 hex digits in a row: an address without its `0x`, a UUID without its dashes, a hash. Each is shaped like a token. */
const BARE_HEX = /[0-9a-f]{32}/i;
const LONGEST = 40;

/** Why a string may not be published, or null when it may (SX6). */
function unshareable(value: string): string | null {
  if (ADDRESS_OR_HASH.test(value)) return "looks like an address or a hash";
  if (EMAIL.test(value)) return "looks like an email address";
  if (UUID.test(value)) return "looks like a UUID";
  if (BARE_HEX.test(value)) return "looks like an id or a hash without its 0x or dashes";
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
 * its decisions or its time looks like an address or hash, an email address or a UUID, holds 32 hex digits in a row (one
 * of those without its `0x` or dashes), or is longer than 40 characters, or when its source is not this module's own
 * sentence (SX6). The script calls it before writing.
 */
export function assertShareable(file: ShadowDecisionsFile): void {
  if (file.source !== SHADOW_DECISIONS_SOURCE) refuse("source", "is not the export's own sentence");
  walk({ readAt: file.readAt, decisions: file.decisions }, "");
}
