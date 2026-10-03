/**
 * What the agent just did, for a person watching (agent activity, spec 2026-10-03-agent-activity-design): each
 * decision since the last one the page has seen, in a sentence, with where to look. Pure: the route reads the rows,
 * this says them, and the page decides how to show them.
 */

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
] as const;

export type ActivityTone = "done" | "stopped";

export interface ActivityItem {
  seq: number;
  /** One sentence: what the agent did, to whom, for how much. */
  text: string;
  /** Done (paid, scheduled, released, received) or stopped (held, asked, flagged, refused by code). */
  tone: ActivityTone;
  /** Where in the workspace a person sees it, or handles it: an org path such as `/approvals#payable-<id>`. */
  path: string;
  /** What that link says. */
  pathLabel: string;
  /** The Arc testnet transaction, when one went out. */
  txHash: string | null;
}

/** A ledger entry as the route reads it. */
export interface ActivityEntry {
  seq: number;
  action: string;
  detail: Record<string, unknown>;
}

/** What the entries are about, read by the route alongside them. */
export interface ActivityRefs {
  invoices: ReadonlyMap<string, { name: string; amount: number; currency: string; status: string; txRef: string | null; scheduledFor: string | null }>;
  milestones: ReadonlyMap<string, { name: string; title: string; amount: number; txRef: string | null }>;
}

const text = (value: unknown) => (typeof value === "string" ? value : null);
const record = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

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
      return { seq: entry.seq, text: `Released ${what} to ${milestone.name}.`, tone: "done", path: "/contractors", pathLabel: "Contractors", txHash: tx };
    }
    return { seq: entry.seq, text: `Held ${what} from ${milestone.name} for you.`, tone: "stopped", path: "/contractors", pathLabel: "Decide in Contractors", txHash: null };
  }

  const id = text(entry.detail.invoiceId);
  const invoice = id ? refs.invoices.get(id) : undefined;
  if (!id || !invoice) return null;
  const amount = activityAmount(invoice.amount, invoice.currency);

  if (entry.action === "ar_received") {
    return { seq: entry.seq, text: `Received ${amount} from ${invoice.name}.`, tone: "done", path: "/invoices", pathLabel: "AP / AR", txHash: arcTx(text(entry.detail.txHash)) };
  }
  const decide = { path: `/approvals#payable-${id}`, pathLabel: "Decide in Approvals" };
  if (blocked) {
    const rule = text(entry.detail.guardrailRule);
    return { seq: entry.seq, text: `Code stopped paying ${invoice.name} ${amount}${rule ? ` (${rule})` : ""}.`, tone: "stopped", ...decide, txHash: null };
  }
  switch (entry.action) {
    case "ap_pay": {
      const execution = record(entry.detail.execution);
      // What the payment ended as, as the entry recorded it; the invoice's status now otherwise.
      const resulting = text(execution?.resultingStatus) ?? invoice.status;
      // A payment that did not go out is held: say so, rather than "paid".
      if (resulting === "held" || resulting === "flagged") {
        return { seq: entry.seq, text: `Tried to pay ${invoice.name} ${amount}; it is held for you.`, tone: "stopped", ...decide, txHash: null };
      }
      const tx = arcTx(text(execution?.txRef)) ?? arcTx(invoice.txRef);
      const sent = resulting === "matched" ? `Sent ${amount} to ${invoice.name}; Arc testnet is confirming it.` : `Paid ${invoice.name} ${amount}.`;
      return { seq: entry.seq, text: sent, tone: "done", path: "/invoices", pathLabel: "AP / AR", txHash: tx };
    }
    case "ap_schedule": {
      const payOn = text(record(entry.detail.decision)?.payOn) ?? invoice.scheduledFor;
      return {
        seq: entry.seq,
        text: `Scheduled ${invoice.name} ${amount}${payOn ? ` for ${shortDay(payOn)}` : ""}.`,
        tone: "done",
        path: "/invoices",
        pathLabel: "AP / AR",
        txHash: null,
      };
    }
    case "ap_request_info":
      return { seq: entry.seq, text: `Asked for details before paying ${invoice.name} ${amount}.`, tone: "stopped", path: "/invoices", pathLabel: "Add details", txHash: null };
    case "ap_flag_fraud":
      return { seq: entry.seq, text: `Flagged ${invoice.name} ${amount} for you to review.`, tone: "stopped", ...decide, txHash: null };
    default:
      return { seq: entry.seq, text: `Held ${invoice.name} ${amount} for you.`, tone: "stopped", ...decide, txHash: null };
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
