/**
 * What the agent just did, for a person watching (agent activity, spec 2026-10-03-agent-activity-design; told with
 * its reasons and timing, decision trail spec R4): each decision since the last one the page has seen, in a sentence,
 * with who decided and what was checked, how long after the person's action, and where to look. Pure: the route reads
 * the rows, this says them, and the page decides how to show them.
 */
import { deciderName } from "./decision-trail";
import { ruleInBrief } from "./next-step";

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
] as const;

/** The people's actions on an invoice that give the agent something to decide: how long after one it decided is told. */
export const TRIGGER_ACTIONS = ["create_invoice", "invoice_details_added", "approval_returned"] as const;

export type ActivityTone = "done" | "stopped";

export interface ActivityItem {
  seq: number;
  /** One sentence: what the agent did, to whom, for how much, and how long after the person's action. */
  text: string;
  /** Who decided and what was checked, or why it stopped; null when the entry says neither. */
  detail: string | null;
  /** Done (paid, scheduled, released, received) or stopped (held, asked, flagged, refused by code). */
  tone: ActivityTone;
  /** Where in the workspace a person sees it, or handles it: an org path such as `/approvals#payable-<id>`. */
  path: string;
  /** What that link says. */
  pathLabel: string;
  /** The Arc testnet transaction, when one went out. */
  txHash: string | null;
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

/** One entry in words, or null when it is not one a person is told about, or what it is about is gone. */
export function activityItem(entry: ActivityEntry, refs: ActivityRefs): ActivityItem | null {
  if (!(ACTIVITY_ACTIONS as readonly string[]).includes(entry.action)) return null;
  const blocked = entry.detail.guardrailBlocked === true;

  if (entry.action.startsWith("milestone_")) {
    const id = text(entry.detail.milestoneId);
    const milestone = id ? refs.milestones.get(id) : undefined;
    if (!milestone) return null;
    const what = `${activityAmount(milestone.amount, "USDC")} for ${milestone.title}`;
    if (entry.action === "milestone_release" && !blocked) {
      const tx = arcTx(text(record(entry.detail.execution)?.txRef)) ?? arcTx(milestone.txRef);
      return { seq: entry.seq, text: `Released ${what} to ${milestone.name}.`, detail: deciderLine(entry.detail), tone: "done", path: "/contractors", pathLabel: "Contractors", txHash: tx };
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
  const amount = activityAmount(invoice.amount, invoice.currency);
  const after = afterTrigger(entry, refs.triggers?.get(id));
  const how = { path: `/invoices#trail-${id}`, pathLabel: "How it decided" };

  if (entry.action === "ar_received") {
    return { seq: entry.seq, text: `Received ${amount} from ${invoice.name}.`, detail: null, tone: "done", path: "/invoices", pathLabel: "AP / AR", txHash: arcTx(text(entry.detail.txHash)) };
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
    return {
      seq: entry.seq,
      text: `Code stopped paying ${invoice.name} ${amount}${after}.`,
      detail: stoppedByCode(entry.detail, text(entry.detail.guardrailRule)),
      tone: "stopped",
      ...decide,
      txHash: null,
    };
  }
  switch (entry.action) {
    case "ap_pay": {
      const execution = record(entry.detail.execution);
      // What the payment ended as, as the entry recorded it; the invoice's status now otherwise.
      const resulting = text(execution?.resultingStatus) ?? invoice.status;
      // A payment that did not go out is held: say so, rather than "paid".
      if (resulting === "held" || resulting === "flagged") {
        return { seq: entry.seq, text: `Tried to pay ${invoice.name} ${amount}; it is held for you.`, detail: deciderLine(entry.detail), tone: "stopped", ...decide, txHash: null };
      }
      const tx = arcTx(text(execution?.txRef)) ?? arcTx(invoice.txRef);
      const sent = resulting === "matched" ? `Sent ${amount} to ${invoice.name}${after}; Arc testnet is confirming it.` : `Paid ${invoice.name} ${amount}${after}.`;
      return { seq: entry.seq, text: sent, detail: joined(deciderLine(entry.detail), checksLine(entry.detail)), tone: "done", ...how, txHash: tx };
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
        path: "/invoices",
        pathLabel: "Add details",
        txHash: null,
      };
    case "ap_flag_fraud":
      return { seq: entry.seq, text: `Flagged ${invoice.name} ${amount} for you to review${after}.`, detail: firstSentence(entry.detail), tone: "stopped", ...decide, txHash: null };
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
