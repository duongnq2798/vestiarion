/**
 * What the agent just did, for a person watching (agent activity, spec 2026-10-03-agent-activity-design; told with
 * its reasons and timing, decision trail spec R4): each decision since the last one the page has seen, in a sentence,
 * with who decided and what was checked, how long after the person's action, and where to look. Pure: the route reads
 * the rows, this says them, and the page decides how to show them.
 */
import { billsHref, invoiceHref } from "./bills-view";
import { deciderName } from "./decision-trail";
import { awaitsVerdict, heldForVerdict, ruleInBrief } from "./next-step";
import { networkProfile, type Network } from "./network";
import { txUrl } from "./payee-chains";

/** The early-payment entries told as they happen (docs/superpowers/specs/2026-10-17-offer-activity-design.md A1). */
export const EARLY_PAYMENT_ACTIONS = [
  "early_payment_offered",
  "early_payment_offer_accepted",
  "early_payment_offer_countered",
  "early_payment_counter_accepted",
  "early_payment_counter_declined",
  "early_payment_offer_withdrawn",
] as const;

/**
 * The agent's discounts to customers for paying early, told as they happen
 * (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md): an offer it emailed, and a receivable paid
 * at the discount. A receivable the agent chose not to offer is not news.
 */
export const CUSTOMER_DISCOUNT_ACTIONS = ["customer_discount_offered", "customer_discount_taken"] as const;

/**
 * The agent's requests for more time, told as they happen (docs/superpowers/specs/2026-10-17-term-requests-follow-up-design.md
 * F3): a request it sent, a supplier's answer, and a request it withdrew. A bill it chose not to ask about is not news.
 */
export const TERM_REQUEST_ACTIONS = [
  "term_request_sent",
  "term_request_accepted",
  "term_request_declined",
  "term_request_withdrawn",
  // A supplier's fewer days, and the agent's answer (term counters F5, F6).
  "term_request_countered",
  "term_counter_accepted",
  "term_counter_declined",
] as const;

/**
 * The agent's word that the wallet will run short, and that it no longer will (docs/superpowers/specs/2026-10-17-cash-short-alert-design.md
 * S4): told once each, and again only when the shortfall changes.
 */
export const CASH_ALERT_ACTIONS = ["cash_short_ahead", "cash_short_cleared"] as const;

/** A supplier's answers to a request for more time: recorded by the system, told beside the agent's own entries (F3). */
export const TERM_ANSWERS = ["term_request_accepted", "term_request_declined", "term_request_countered"] as const;

/** A supplier's answers to an early-payment offer: recorded by the system, told beside the agent's own entries (A2). */
export const SUPPLIER_ANSWERS = ["early_payment_offer_accepted", "early_payment_offer_countered"] as const;

/** The agent's ledger actions a person is told about as they happen. A treasury hold, every cycle, is not news. */
export const ACTIVITY_ACTIONS = [
  "ap_pay",
  "ap_schedule",
  "ap_hold",
  "ap_request_info",
  "ap_flag_fraud",
  "milestone_release",
  "milestone_hold",
  "ar_received",
  "ar_reminder_sent",
  // A payment that has not confirmed, told by the transfer watch (stuck-transfer alert D6).
  "payment_stuck",
  // Early payment the agent negotiates (offer activity A1): its offers, a supplier's answer or counter, its answer to that,
  // and an offer it withdrew. A person's own offer, and a bill the agent chose not to offer, are not news.
  ...EARLY_PAYMENT_ACTIONS,
  ...CUSTOMER_DISCOUNT_ACTIONS,
  // Requests for more time (term requests follow-up F3).
  ...TERM_REQUEST_ACTIONS,
  // The wallet will run short, or no longer will (cash short alert S4).
  ...CASH_ALERT_ACTIONS,
] as const;

/** The people's actions on an invoice that give the agent something to decide: how long after one it decided is told. */
export const TRIGGER_ACTIONS = ["create_invoice", "invoice_details_added", "approval_returned"] as const;

export type ActivityTone = "done" | "pending" | "stopped" | "notice";

export interface ActivityItem {
  seq: number;
  /** One sentence: what the agent did, to whom, for how much, and how long after the person's action. */
  text: string;
  /** Who decided and what was checked, or why it stopped; null when the entry says neither. */
  detail: string | null;
  /**
   * Done (paid or released as Circle confirmed it, simulated, scheduled, received), pending (submitted and not confirmed
   * by Circle yet, its outcome unknown, or a decision whose transfer the entry does not record), stopped (held,
   * asked, flagged, refused by code), or notice (a warning that is no decision for a person: the cash will run short).
   */
  tone: ActivityTone;
  /** Where in the workspace a person sees it, or handles it: an org path such as `/approvals#payable-<id>`. */
  path: string;
  /** What that link says. */
  pathLabel: string;
  /** The transaction, when one went out. */
  txHash: string | null;
  /** Its link on the explorer of the workspace's network (network threading P6): chats and pages use this one. */
  txUrl: string | null;
  /** The workspace's network, which chats name beside the transaction (mainnet copy C1). */
  network: Network;
  /** The payable a person decides, on an item that sends them to Approvals: what a chat's card is about (Slack design S8). */
  invoiceId?: string;
}

/** A ledger entry as the route reads it. */
export interface ActivityEntry {
  seq: number;
  ts?: string;
  action: string;
  detail: Record<string, unknown>;
}

/** What the entries are about, read by the route alongside them. */
export interface ActivityRefs {
  invoices: ReadonlyMap<string, { name: string; amount: number; currency: string; status: string; txRef: string | null; scheduledFor: string | null }>;
  milestones: ReadonlyMap<string, { name: string; title: string; amount: number; txRef: string | null }>;
  /** Each invoice's people's actions that gave the agent work (`TRIGGER_ACTIONS`), any order. */
  triggers?: ReadonlyMap<string, ReadonlyArray<{ seq: number; ts: string; action: string }>>;
  /** The workspace's network, for each transaction's link. */
  network: Network;
}

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const record = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const number = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** An amount as the app writes it (`fmt`): two decimals at least, up to six. */
export function activityAmount(amount: number, token: string): string {
  return `${AMOUNT.format(amount)} ${token}`;
}

const arcTx = (value: string | null | undefined) => (value && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : null);

/** The UTC day of an ISO date, as "Oct 5". */
function shortDay(value: string): string {
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return day.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const AFTER: Record<(typeof TRIGGER_ACTIONS)[number], string> = {
  create_invoice: "after it was added",
  invoice_details_added: "after details were added",
  approval_returned: "after it was returned",
};

/** What came back, for a decision that followed a reopen because a fresh quote cleared what held it (FX re-evaluation F6). */
const DECIDED_AGAIN: Record<string, string> = {
  rate_available: " · decided again once a EURC rate was quoted",
  swap_available: " · decided again once a USDC→EURC swap was quoted",
  swap_cost_within_cap: " · decided again once a swap cost within its cap",
  value_within_limit: " · decided again once the rate brought it within the limit",
};

/** " · 26 s after it was added": from the latest person's action on the invoice before the decision, within an hour. */
export function afterTrigger(entry: ActivityEntry, triggers: ReadonlyArray<{ seq: number; ts: string; action: string }> | undefined): string {
  if (!entry.ts || !triggers) return "";
  const latest = [...triggers].filter((trigger) => trigger.seq < entry.seq).sort((a, b) => b.seq - a.seq)[0];
  if (!latest) return "";
  const seconds = Math.round((Date.parse(entry.ts) - Date.parse(latest.ts)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3_600) return "";
  const words = AFTER[latest.action as keyof typeof AFTER];
  if (!words) return "";
  return ` · ${seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`} ${words}`;
}

/** Who decided, and whether the written policy agreed: "DeepSeek decided, as the written policy would." */
function deciderLine(detail: Record<string, unknown>): string | null {
  if (!("decisionMode" in detail)) return null;
  const decider = deciderName(detail.decisionMode);
  if (decider === "The written policy") return "Decided by the written policy: no model answered.";
  const agreed = detail.agreedWithReference;
  return agreed === true ? `${decider} decided, as the written policy would.` : agreed === false ? `${decider} decided; the written policy would have decided otherwise.` : `${decider} decided.`;
}

/** What a payment's decision checked and passed, in one short line, from the facts it recorded. */
function checksLine(detail: Record<string, unknown>): string | null {
  const observed = record(detail.observed) ?? {};
  const checks: string[] = [];
  if (text(observed.poReference) && observed.goodsReceived === true) checks.push("purchase order and goods");
  // A counterparty paid without purchase orders: its match is the goods received (three-way match design M4).
  else if (observed.purchaseOrderRequired === false && observed.goodsReceived === true) checks.push("goods received, with no purchase order needed");
  const limit = number(observed.paymentLimit);
  if (limit !== null) checks.push(`the ${AMOUNT.format(limit)} USDC limit`);
  if (observed.riskLevel === "clear") checks.push("screening");
  if (text(record(record(detail.onChainLimit)?.verdict)?.state) === "allowed") checks.push("the spending-limit contract");
  return checks.length > 0 ? `Checks passed: ${checks.join(", ")}.` : null;
}

/** What code did to the model's payment, in one sentence: "DeepSeek decided to pay it; code stopped it: …". */
function stoppedByCode(detail: Record<string, unknown>, rule: string | null): string | null {
  const brief = ruleInBrief(rule);
  if (!brief) return null;
  const decider = "decisionMode" in detail ? deciderName(detail.decisionMode) : "The agent";
  return `${decider} decided to pay it; code stopped it: ${brief}.`;
}

/** The first sentence of the model's reasoning, for why it stopped, cut to a toast's length. */
function firstSentence(detail: Record<string, unknown>): string | null {
  const reasoning = text(record(detail.decision)?.reasoning);
  if (!reasoning) return null;
  const sentence = reasoning.split(/(?<=[.!?])\s/)[0] ?? reasoning;
  return sentence.length > 180 ? `${sentence.slice(0, 177).trimEnd()}…` : sentence;
}

const joined = (...parts: Array<string | null>) => parts.filter((part): part is string => part !== null).join(" ") || null;

/**
 * What the entry's transfer ended as, as the entry recorded it, never the bill's status now (settlement lifecycle I17):
 * `confirmed` once Circle confirmed it, `simulated` when the sandbox's simulator made it, `submitted` while Circle has
 * it and has not confirmed it, and `unknown` when Circle never answered the send, so no Circle id was recorded (L3,
 * "Outcome unknown"). A send in flight is never called simulated (L4). Null when the entry records no transfer.
 */
type TransferOutcome = "confirmed" | "simulated" | "submitted" | "unknown" | null;

function transferOutcome(execution: Record<string, unknown> | null, statuses: { confirmed: string; sent: string }): TransferOutcome {
  const resulting = text(execution?.resultingStatus);
  // The simulator's mode, or its own transaction id (`sim_…`), which nothing else makes.
  const simulated = text(execution?.chainMode) === "simulate" || (text(execution?.txRef)?.startsWith("sim_") ?? false);
  if (resulting === statuses.confirmed) return simulated ? "simulated" : "confirmed";
  if (resulting === statuses.sent) return text(execution?.txRef) ? "submitted" : "unknown";
  return null;
}

/** What a transfer still in flight waits for, after "Submitted …": Circle's confirmation, or Circle's answer to the send. */
function inFlight(outcome: "submitted" | "unknown", network: Network): string {
  return outcome === "submitted"
    ? `waiting for Circle to confirm it on ${networkProfile(network).label}`
    : "Circle has not answered yet, so the outcome is unknown and nothing goes out again until it does";
}

/** One entry in words, or null when it is not one a person is told about, or what it is about is gone. */
export function activityItem(entry: ActivityEntry, refs: ActivityRefs): ActivityItem | null {
  const item = itemOf(entry, refs);
  return item ? { ...item, txUrl: item.txHash ? txUrl(refs.network, item.txHash) : null, network: refs.network } : null;
}

function itemOf(entry: ActivityEntry, refs: ActivityRefs): Omit<ActivityItem, "txUrl" | "network"> | null {
  if (!(ACTIVITY_ACTIONS as readonly string[]).includes(entry.action)) return null;
  if (entry.action === "payment_stuck") return stuckItem(entry, refs);
  if ((CASH_ALERT_ACTIONS as readonly string[]).includes(entry.action)) return cashAlertItem(entry);
  const blocked = entry.detail.guardrailBlocked === true;

  if (entry.action.startsWith("milestone_")) {
    const id = text(entry.detail.milestoneId);
    const milestone = id ? refs.milestones.get(id) : undefined;
    if (!milestone) return null;
    const what = `${activityAmount(milestone.amount, "USDC")} for ${milestone.title}`;
    if (entry.action === "milestone_release" && !blocked) {
      const execution = record(entry.detail.execution);
      // What the release ended as, as the entry recorded it: one that did not go out is held, never "released".
      const resulting = text(execution?.resultingStatus);
      if (resulting === "held") {
        const why = text(execution?.heldBecause) === "cash_shortfall" ? "The operating wallet did not hold its USDC; the agent decides it again once cash comes in." : deciderLine(entry.detail);
        return { seq: entry.seq, text: `Tried to release ${what} to ${milestone.name}; it is held for you.`, detail: why, tone: "stopped", path: "/contractors", pathLabel: "Decide in Contractors", txHash: null };
      }
      const tx = arcTx(text(execution?.txRef)) ?? arcTx(milestone.txRef);
      // Released only once Circle confirmed it (I17): submitted, an unknown outcome, or no transfer recorded say so.
      const outcome = transferOutcome(execution, { confirmed: "paid", sent: "verified" });
      const said =
        outcome === "confirmed"
          ? `Released ${what} to ${milestone.name}; Circle confirmed it on ${networkProfile(refs.network).label}.`
          : outcome === "simulated"
            ? `Released ${what} to ${milestone.name} in the sandbox (simulated).`
            : outcome
              ? `Submitted ${what} to ${milestone.name}; ${inFlight(outcome, refs.network)}.`
              : `Decided to release ${what} to ${milestone.name}.`;
      const done = outcome === "confirmed" || outcome === "simulated";
      return { seq: entry.seq, text: said, detail: deciderLine(entry.detail), tone: done ? "done" : "pending", path: "/contractors", pathLabel: "Contractors", txHash: tx };
    }
    return {
      seq: entry.seq,
      text: `Held ${what} from ${milestone.name} for you.`,
      detail: firstSentence(entry.detail),
      tone: "stopped",
      path: "/contractors",
      pathLabel: "Decide in Contractors",
      txHash: null,
    };
  }

  const id = text(entry.detail.invoiceId);
  const invoice = id ? refs.invoices.get(id) : undefined;
  if (!id || !invoice) return null;
  if ((EARLY_PAYMENT_ACTIONS as readonly string[]).includes(entry.action)) return earlyPaymentItem(entry, id, invoice);
  if ((TERM_REQUEST_ACTIONS as readonly string[]).includes(entry.action)) return termRequestItem(entry, id, invoice);
  if ((CUSTOMER_DISCOUNT_ACTIONS as readonly string[]).includes(entry.action)) return customerDiscountItem(entry, id, invoice);
  const item = invoiceItem(entry, refs, id, invoice);
  // A stopped payable is what a person decides: a chat's card names it (Slack design S8). One held for a person's
  // verdict is settled by giving one, in Vestiarion, so a chat draws no card for it (shadow mode S4).
  return item.tone === "stopped" && !awaitsVerdict(entry.detail) ? { ...item, invoiceId: id } : item;
}

/**
 * A payment that has not confirmed (stuck-transfer alert D6, D7): stopped, with what Circle said, and the payment's page.
 * It is not a decision to make, so it carries no `invoiceId`, and a chat draws no card to approve it.
 */
function stuckItem(entry: ActivityEntry, refs: ActivityRefs): Omit<ActivityItem, "txUrl" | "network"> | null {
  const invoiceId = text(entry.detail.invoiceId);
  const milestoneId = text(entry.detail.milestoneId);
  const payee = invoiceId ? refs.invoices.get(invoiceId)?.name : milestoneId ? refs.milestones.get(milestoneId)?.name : undefined;
  if (!payee) return null;
  const amount = activityAmount(number(entry.detail.amount) ?? 0, text(entry.detail.currency) ?? "USDC");
  return {
    seq: entry.seq,
    // Submitted, never "sent": Circle may not have taken it (I17).
    text: `Payment of ${amount} to ${payee} has not confirmed ${number(entry.detail.minutes) ?? 0} min after it was submitted to Circle on ${networkProfile(refs.network).label}.`,
    detail: stuckCircleLine(entry.detail),
    tone: "stopped",
    path: invoiceId ? invoiceHref(invoiceId, "trail") : "/contractors",
    pathLabel: invoiceId ? "How it decided" : "Contractors",
    txHash: arcTx(text(entry.detail.txHash)),
  };
}

/** The payment plan, where a person sees each day's balance (cash short alert S4). */
const PAYMENT_PLAN_PATH = billsHref({ tab: "plan" });

/**
 * The wallet will run short, or no longer will, in words (cash short alert S4): how much, by when, the customers' money
 * expected by then, and what the agent is doing about it. Not a decision for a person, so no chat draws a card for it.
 */
function cashAlertItem(entry: ActivityEntry): Omit<ActivityItem, "txUrl" | "network"> | null {
  if (entry.action === "cash_short_cleared") {
    return { seq: entry.seq, text: "The cash covers everything due in the next 30 days again.", detail: null, tone: "done", path: PAYMENT_PLAN_PATH, pathLabel: "See the payment plan", txHash: null };
  }
  const shortOn = text(entry.detail.shortOn);
  const lowestOn = text(entry.detail.lowestOn) ?? shortOn;
  const need = number(entry.detail.need);
  if (!shortOn || !lowestOn || need === null) return null;
  const usdc = (value: number) => activityAmount(value, "USDC");
  const shortBy = number(entry.detail.shortBy) ?? need;
  const said =
    lowestOn === shortOn
      ? `Cash runs short on ${shortDay(shortOn)}: ${usdc(need)} more is needed by then to pay what is due.`
      : `Cash runs short on ${shortDay(shortOn)}: ${usdc(shortBy)} short that day, and ${usdc(need)} by ${shortDay(lowestOn)} to pay everything due.`;
  const expected = number(entry.detail.expectedBy) ?? 0;
  // Enough on time, enough in all but some of it after the first short day, or not enough (review of #420).
  const enough =
    entry.detail.coveredWithExpected === true
      ? "enough if each pays on time"
      : expected >= need
        ? `enough in all, but not all of it by ${shortDay(shortOn)}`
        : "not enough even if each pays on time";
  const customers =
    expected > 0
      ? `Customers owe ${usdc(expected)} by ${shortDay(lowestOn)}, ${enough}; it is not counted until it arrives.`
      : `No customer payment is expected by ${shortDay(lowestOn)}.`;
  const doing = record(entry.detail.doing);
  const held = record(doing?.heldForCash);
  const parts: string[] = [];
  const heldCount = number(held?.count);
  if (heldCount !== null && heldCount > 0) parts.push(`holds ${heldCount === 1 ? "1 bill" : `${heldCount} bills`} for want of cash (${usdc(number(held?.total) ?? 0)})`);
  const requests = number(doing?.termRequestsOpen);
  if (requests !== null && requests > 0) parts.push(`has ${requests === 1 ? "1 request" : `${requests} requests`} for more time open`);
  const discounts = number(doing?.customerDiscountsOpen);
  if (discounts !== null && discounts > 0) parts.push(`has ${discounts === 1 ? "1 customer discount" : `${discounts} customer discounts`} open`);
  const agent = parts.length > 0 ? ` The agent ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`}.` : "";
  // A warning, not a decision for a person: it neither counts among what waits for them nor takes the stopped mark.
  return { seq: entry.seq, text: said, detail: `${customers}${agent}`, tone: "notice", path: PAYMENT_PLAN_PATH, pathLabel: "See the payment plan", txHash: null };
}

/** What Circle said of a payment that has not confirmed, or that it was not asked, or never answered the send. */
function stuckCircleLine(detail: Record<string, unknown>): string {
  if (detail.sendAnswered === false) return "Circle never answered when it was submitted, so the outcome is unknown.";
  if (detail.circleAsked !== true) return "Circle could not be asked just now.";
  const state = text(detail.providerState);
  return state === "STUCK" ? "Circle shows it stuck." : `Circle shows it as ${state ?? "pending"}.`;
}

const pct = (value: unknown) => `${(number(value) ?? 0).toFixed(2)}%`;

/**
 * An early-payment step, in words (docs/superpowers/specs/2026-10-17-offer-activity-design.md A1-A3): the agent's offer
 * and who decided it, a supplier's answer or counter, the agent's answer to a counter, and an offer the agent withdrew.
 * A person's own offer or withdrawal is not told. None is a decision for a person, so none is stopped, and no chat draws
 * a card for it.
 */
function earlyPaymentItem(
  entry: ActivityEntry,
  id: string,
  invoice: ActivityRefs["invoices"] extends ReadonlyMap<string, infer V> ? V : never
): Omit<ActivityItem, "txUrl" | "network"> | null {
  const detail = entry.detail;
  const currency = text(detail.currency) ?? invoice.currency;
  const amount = activityAmount(invoice.amount, invoice.currency);
  const offered = number(detail.offeredAmount);
  const today = offered !== null ? `${activityAmount(offered, currency)} today instead of ${amount}` : null;
  const how = { path: invoiceHref(id, "trail"), pathLabel: "How it decided" };
  const byAgent = text(detail.via) === "agent";
  // Code answered without a model (offer counters N3): say so, rather than name a model that was never asked.
  const decided = text(detail.decisionMode) === "code" ? joined("Code declined it, without asking a model:", firstSentence(detail)) : deciderLine(detail);
  switch (entry.action) {
    case "early_payment_offered":
      if (!byAgent) return null;
      return { seq: entry.seq, text: `Offered ${invoice.name} payment today for ${pct(detail.discountPct)} off, by email: ${today ?? amount}.`, detail: deciderLine(detail), tone: "done", ...how, txHash: null };
    case "early_payment_offer_accepted":
      return { seq: entry.seq, text: `${invoice.name} accepted ${pct(detail.discountPct)} off for payment today: ${today ?? amount}.`, detail: null, tone: "done", ...how, txHash: null };
    case "early_payment_offer_countered":
      return { seq: entry.seq, text: `${invoice.name} proposed ${pct(detail.counterPct)} off instead of ${pct(detail.discountPct)}; the agent answers it now.`, detail: null, tone: "pending", ...how, txHash: null };
    case "early_payment_counter_accepted":
      return { seq: entry.seq, text: `Accepted ${invoice.name}'s ${pct(detail.counterPct)}: paying ${today ?? amount}.`, detail: decided, tone: "done", ...how, txHash: null };
    case "early_payment_counter_declined":
      return { seq: entry.seq, text: `Kept the original terms with ${invoice.name}: its ${pct(detail.counterPct)} declined, so it is paid on its due date.`, detail: decided, tone: "done", ...how, txHash: null };
    case "early_payment_offer_withdrawn": {
      if (!byAgent) return null;
      const why = text(detail.reason) === "cash" ? "the cash no longer covers it" : "its email never went";
      return { seq: entry.seq, text: `Withdrew the early-payment offer to ${invoice.name}: ${why}.`, detail: null, tone: "done", ...how, txHash: null };
    }
    default:
      return null;
  }
}

/**
 * A discount the agent offered a customer for paying early, and a receivable paid at it, in words (customer discounts).
 * Neither is a decision for a person, so neither is stopped, and no chat draws a card for it.
 */
function customerDiscountItem(
  entry: ActivityEntry,
  id: string,
  invoice: ActivityRefs["invoices"] extends ReadonlyMap<string, infer V> ? V : never
): Omit<ActivityItem, "txUrl" | "network"> | null {
  const detail = entry.detail;
  const how = { path: invoiceHref(id), pathLabel: "Open the receivable" };
  switch (entry.action) {
    case "customer_discount_offered": {
      const offered = number(detail.offeredAmount);
      const payBy = text(detail.payBy);
      const what = offered !== null ? `${activityAmount(offered, "USDC")}${payBy ? ` by ${payBy}` : ""} instead of ${activityAmount(invoice.amount, invoice.currency)}` : activityAmount(invoice.amount, invoice.currency);
      return { seq: entry.seq, text: `Offered ${invoice.name} ${pct(detail.discountPct)} off for paying early, by email, while bills are held for cash: ${what}.`, detail: deciderLine(detail), tone: "done", ...how, txHash: null };
    }
    case "customer_discount_taken": {
      const received = number(detail.received);
      const cost = number(detail.discount);
      return {
        seq: entry.seq,
        text: `${invoice.name} paid ${received !== null ? activityAmount(received, "USDC") : activityAmount(invoice.amount, invoice.currency)} early, at ${pct(detail.discountPct)} off${cost !== null ? `: the discount cost ${activityAmount(cost, "USDC")}` : ""}.`,
        detail: null,
        tone: "done",
        ...how,
        txHash: text(detail.txHash),
      };
    }
    default:
      return null;
  }
}

/**
 * A request for more time, in words (F3): the agent's request and who decided it, a supplier's answer, and a request the
 * agent withdrew, with why. None is a decision for a person, so none is stopped, and no chat draws a card for it; a
 * declined request leaves the bill held, which its own card already says.
 */
function termRequestItem(
  entry: ActivityEntry,
  id: string,
  invoice: ActivityRefs["invoices"] extends ReadonlyMap<string, infer V> ? V : never
): Omit<ActivityItem, "txUrl" | "network"> | null {
  const detail = entry.detail;
  const amount = activityAmount(invoice.amount, invoice.currency);
  const days = number(detail.days);
  const dayWord = (n: number | null) => (n === null ? "more time" : n === 1 ? "1 more day" : `${n} more days`);
  const newDue = text(detail.newDueDate)?.slice(0, 10) ?? null;
  const how = { path: invoiceHref(id, "trail"), pathLabel: "How it decided" };
  switch (entry.action) {
    case "term_request_sent":
      return { seq: entry.seq, text: `Asked ${invoice.name} for ${dayWord(days)} on ${amount}, by email${newDue ? `: due ${newDue}` : ""}.`, detail: deciderLine(detail), tone: "done", ...how, txHash: null };
    case "term_request_accepted":
      return { seq: entry.seq, text: `${invoice.name} agreed to ${dayWord(days)}${newDue ? `: the bill now falls due ${newDue}` : ""}.`, detail: null, tone: "done", ...how, txHash: null };
    case "term_request_declined":
      return { seq: entry.seq, text: `${invoice.name} declined the request for more time: the bill keeps its due date and waits for a person.`, detail: null, tone: "done", ...how, txHash: null };
    case "term_request_countered":
      return { seq: entry.seq, text: `${invoice.name} proposed ${dayWord(number(detail.counterDays))} instead of ${days ?? "the"}; the agent answers it now.`, detail: null, tone: "pending", ...how, txHash: null };
    case "term_counter_accepted":
      return { seq: entry.seq, text: `Accepted ${invoice.name}'s ${dayWord(number(detail.counterDays))}${newDue ? `: the bill now falls due ${newDue}` : ""}.`, detail: deciderLine(detail), tone: "done", ...how, txHash: null };
    case "term_counter_declined":
      return { seq: entry.seq, text: `Declined ${invoice.name}'s ${dayWord(number(detail.counterDays))}: the bill keeps its due date.`, detail: deciderLine(detail), tone: "done", ...how, txHash: null };
    case "term_request_withdrawn": {
      const reason = text(detail.reason);
      const why = reason === "paid" ? "the bill is being paid on time" : reason === "not_needed" ? "it is no longer needed" : "its email never went";
      const told = detail.supplierTold === true ? ", and told them" : "";
      return { seq: entry.seq, text: `Withdrew the request for more time to ${invoice.name}: ${why}${told}.`, detail: null, tone: "done", ...how, txHash: null };
    }
    default:
      return null;
  }
}

/** An invoice's decision, in words. */
function invoiceItem(
  entry: ActivityEntry,
  refs: ActivityRefs,
  id: string,
  invoice: ActivityRefs["invoices"] extends ReadonlyMap<string, infer V> ? V : never
): Omit<ActivityItem, "txUrl" | "network"> {
  const blocked = entry.detail.guardrailBlocked === true;
  const amount = activityAmount(invoice.amount, invoice.currency);
  const after = DECIDED_AGAIN[text(record(entry.detail.reevaluation)?.trigger) ?? ""] ?? afterTrigger(entry, refs.triggers?.get(id));
  // The bill's card, opened over Bills & receivables at how it was decided (Bills & receivables tabs B4).
  const how = { path: invoiceHref(id, "trail"), pathLabel: "How it decided" };

  if (entry.action === "ar_received") {
    // Read from Circle's completed inbound transfers only (receivables on Arc R3, R4): the source is named (I17).
    return {
      seq: entry.seq,
      text: `Received ${amount} from ${invoice.name} on ${networkProfile(refs.network).label}: Circle reported the transfer complete.`,
      detail: null,
      tone: "done",
      path: "/invoices",
      pathLabel: "Bills & receivables",
      txHash: arcTx(text(entry.detail.txHash)),
    };
  }
  if (entry.action === "ar_reminder_sent") {
    const tone = text(entry.detail.tone) ?? "friendly";
    return {
      seq: entry.seq,
      text: `Reminded ${invoice.name} by email of ${amount}${tone === "final" ? ", a final reminder" : ` (${tone})`}.`,
      detail: deciderLine(entry.detail),
      tone: "done",
      ...how,
      txHash: null,
    };
  }
  const decide = { path: `/approvals#payable-${id}`, pathLabel: "Decide in Approvals" };
  if (blocked) {
    // In shadow mode a payment code held still waits for a person's verdict, given in Vestiarion (shadow mode S4).
    const verdict = awaitsVerdict(entry.detail);
    return {
      seq: entry.seq,
      text: verdict
        ? `Code stopped paying ${invoice.name} ${amount}${after}; it waits for your verdict in shadow mode.`
        : `Code stopped paying ${invoice.name} ${amount}${after}.`,
      detail: stoppedByCode(entry.detail, text(entry.detail.guardrailRule)),
      tone: "stopped",
      ...decide,
      ...(verdict ? { pathLabel: "Give your verdict" } : {}),
      txHash: null,
    };
  }
  switch (entry.action) {
    case "ap_pay": {
      const execution = record(entry.detail.execution);
      // What the payment ended as, as the entry recorded it; never the invoice's status now, which a later cycle or a
      // person may have moved since (I17).
      const resulting = text(execution?.resultingStatus);
      // Held in shadow mode: it passed every check and waits for a person to agree (shadow mode S2, S4).
      if (heldForVerdict(entry.detail)) {
        return {
          seq: entry.seq,
          text: `Decided to pay ${invoice.name} ${amount}${after}; it waits for your verdict in shadow mode.`,
          detail: joined(deciderLine(entry.detail), checksLine(entry.detail)),
          tone: "stopped",
          path: decide.path,
          pathLabel: "Give your verdict",
          txHash: null,
        };
      }
      // A payment that did not go out is held: say so, rather than "paid".
      if (resulting === "held" || resulting === "flagged") {
        return { seq: entry.seq, text: `Tried to pay ${invoice.name} ${amount}; it is held for you.`, detail: deciderLine(entry.detail), tone: "stopped", ...decide, txHash: null };
      }
      const tx = arcTx(text(execution?.txRef)) ?? arcTx(invoice.txRef);
      // Paid only once Circle confirmed it (I17): submitted, an unknown outcome, or no transfer recorded say so.
      const outcome = transferOutcome(execution, { confirmed: "paid", sent: "matched" });
      const said =
        outcome === "confirmed"
          ? `Paid ${invoice.name} ${amount}${after}; Circle confirmed it on ${networkProfile(refs.network).label}.`
          : outcome === "simulated"
            ? `Paid ${invoice.name} ${amount}${after} in the sandbox (simulated).`
            : outcome
              ? `Submitted ${amount} to ${invoice.name}${after}; ${inFlight(outcome, refs.network)}.`
              : `Decided to pay ${invoice.name} ${amount}${after}.`;
      const done = outcome === "confirmed" || outcome === "simulated";
      return { seq: entry.seq, text: said, detail: joined(deciderLine(entry.detail), checksLine(entry.detail)), tone: done ? "done" : "pending", ...how, txHash: tx };
    }
    case "ap_schedule": {
      const payOn = text(record(entry.detail.decision)?.payOn) ?? invoice.scheduledFor;
      return {
        seq: entry.seq,
        text: `Scheduled ${invoice.name} ${amount}${payOn ? ` for ${shortDay(payOn)}` : ""}${after}.`,
        detail: joined(deciderLine(entry.detail), firstSentence(entry.detail)),
        tone: "done",
        ...how,
        txHash: null,
      };
    }
    case "ap_request_info":
      return {
        seq: entry.seq,
        text: `Asked for details before paying ${invoice.name} ${amount}${after}.`,
        detail: firstSentence(entry.detail),
        tone: "stopped",
        // Its card, where Add details is.
        path: invoiceHref(id),
        pathLabel: "Add details",
        txHash: null,
      };
    case "ap_flag_fraud":
      return { seq: entry.seq, text: `Flagged ${invoice.name} ${amount} for you to review${after}.`, detail: firstSentence(entry.detail), tone: "stopped", ...decide, txHash: null };
    case "ap_hold": {
      // Held days before the day it was set for, because the cash will not cover it then (cash ahead A4); held then for
      // anything else, it says so as any hold does.
      const setFor = text(record(entry.detail.cashAhead)?.scheduledFor);
      if (setFor && text(record(entry.detail.execution)?.heldBecause) === "cash_shortfall") {
        return { seq: entry.seq, text: `Held ${invoice.name} ${amount}, set for ${shortDay(setFor)}: the cash will not cover it then.`, detail: firstSentence(entry.detail), tone: "stopped", ...decide, txHash: null };
      }
      return { seq: entry.seq, text: `Held ${invoice.name} ${amount} for you${after}.`, detail: firstSentence(entry.detail), tone: "stopped", ...decide, txHash: null };
    }
    default:
      return { seq: entry.seq, text: `Held ${invoice.name} ${amount} for you${after}.`, detail: firstSentence(entry.detail), tone: "stopped", ...decide, txHash: null };
  }
}

/** Everything new, in the order it happened. */
export function activityItems(entries: readonly ActivityEntry[], refs: ActivityRefs): ActivityItem[] {
  return [...entries]
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => activityItem(entry, refs))
    .filter((item): item is ActivityItem => item !== null);
}

/** How long the page waits before asking again: soon while the agent works or is about to, rarely otherwise. */
export function nextPollMs(state: { running: boolean; expectingUntil: number; now: number }): number {
  return state.running || state.now < state.expectingUntil ? 3_000 : 20_000;
}

/** How long after a person's action the page expects the agent to start: the event cycle starts within seconds. */
export const EXPECT_AGENT_MS = 90_000;

/** The DOM event a form dispatches after a successful action, so the page watches the agent closely for a while. */
export const AGENT_EXPECTED_EVENT = "vestiarion:agent-expected";

/** How many new decisions are told one by one; more than this are told as one. */
export const TOLD_ONE_BY_ONE = 2;

/** What the header says while the agent works. */
export function workingLabel(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(startedAt)) / 1000));
  return Number.isFinite(seconds) ? `The agent is working · ${seconds} s` : "The agent is working";
}
