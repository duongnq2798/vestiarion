/**
 * How the agent decided a payable, step by step, from the signed entries about it (decision trail, spec
 * 2026-10-03-decision-trail-design): who added it, what a person changed, what the model decided and whether the
 * written policy agreed, what code and the spending-limit contract checked, and what reached Arc. Pure: the page
 * hands it the entries it already read.
 */

/** A ledger entry as the trail reads it. */
export interface TrailEntry {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  summary: string;
  detail: Record<string, unknown>;
}

export interface TrailStep {
  seq: number;
  at: string;
  who: "agent" | "person" | "system";
  /** One sentence: what happened. */
  text: string;
  /** What was checked, or why it stopped, one short line each. */
  notes: string[];
  tone: "done" | "stopped" | "neutral";
  /** The Arc testnet transaction this step sent, when it sent one. */
  txHash: string | null;
}

/** The most steps a trail shows: the latest ones. */
export const TRAIL_STEPS_SHOWN = 10;

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const record = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const number = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const arcTx = (value: unknown) => (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : null);
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const usdc = (value: number) => `${AMOUNT.format(value)} USDC`;

/** Who decided, as a person reads it: the model by its name, or the written policy when no model answered. */
export function deciderName(decisionMode: unknown): string {
  switch (decisionMode) {
    case "deepseek":
      return "DeepSeek";
    case "heuristic":
      return "The written policy";
    case "anthropic":
    case "claude":
      return "Claude";
    default:
      return "The model";
  }
}

const VERBS: Record<string, (detail: Record<string, unknown>) => string> = {
  ap_pay: () => "to pay it",
  ap_schedule: (detail) => {
    const payOn = text(record(detail.decision)?.payOn);
    return payOn ? `to pay it on ${dayOf(payOn)}` : "to pay it on a later day";
  },
  ap_hold: () => "to hold it for a person",
  ap_request_info: () => "to ask for more information before paying it",
  ap_flag_fraud: () => "to flag it for review",
};

/** "Oct 5", the UTC day of an ISO date. */
function dayOf(value: string): string {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** What the decision checked, from the facts it recorded: each a short line, marked passed or not. */
function checksOf(detail: Record<string, unknown>, paying: boolean): string[] {
  const observed = record(detail.observed) ?? {};
  const notes: string[] = [];
  const po = text(observed.poReference);
  if ("poReference" in observed || "goodsReceived" in observed) {
    notes.push(
      po && observed.goodsReceived === true
        ? `✓ Purchase order ${po} on file and the goods received`
        : `✗ ${po ? `Purchase order ${po} on file, but the goods not marked received` : "No purchase order on file"}`
    );
  }
  const risk = text(observed.riskLevel);
  if (risk) notes.push(risk === "clear" ? "✓ Counterparty screened clear" : `${risk === "high" ? "✗" : "·"} Counterparty screened ${risk}`);
  const limit = number(observed.paymentLimit);
  const amount = number(detail.usdcValue) ?? number(observed.amount);
  if (limit !== null && amount !== null) {
    notes.push(amount <= limit + 0.0000005 ? `✓ ${usdc(amount)} within its ${usdc(limit)} limit` : `✗ ${usdc(amount)} above its ${usdc(limit)} limit`);
  }
  const duplicates = number(record(observed.duplicateCheck)?.matchesTotal);
  if (duplicates !== null) notes.push(duplicates === 0 ? "✓ No duplicate found" : `· Resembles ${duplicates} earlier ${duplicates === 1 ? "invoice" : "invoices"}`);
  if (paying && observed.addressUnconfirmed === true) notes.push("✗ Its payment address changed and is not confirmed");
  return notes;
}

/** What code said about the decision: a guardrail's refusal, the spending-limit contract's verdict. */
function codeNotes(detail: Record<string, unknown>): { notes: string[]; refused: boolean } {
  const notes: string[] = [];
  const refused = detail.guardrailBlocked === true;
  const rule = text(detail.guardrailRule);
  if (refused) notes.push(`✗ Code refused it before anything was sent${rule ? `: ${rule}` : ""}`);
  const verdict = record(record(detail.onChainLimit)?.verdict);
  const state = text(verdict?.state);
  if (state === "allowed") notes.push("✓ The spending-limit contract on Arc allowed it");
  if (state === "refused") notes.push(`✗ The spending-limit contract on Arc would refuse it${text(verdict?.error) ? ` (${text(verdict?.error)})` : ""}`);
  return { notes, refused };
}

/** ", as the written policy would", or how the model departed from it; nothing for the written policy itself. */
function agreement(detail: Record<string, unknown>): string {
  if (deciderName(detail.decisionMode) === "The written policy") return "";
  return detail.agreedWithReference === true ? ", as the written policy would" : detail.agreedWithReference === false ? "; the written policy would have decided otherwise" : "";
}

/** One entry as a step, or null for one the trail does not show (receipts, links). */
export function trailStep(entry: TrailEntry): TrailStep | null {
  const detail = entry.detail;
  const base = { seq: entry.seq, at: entry.ts, notes: [] as string[], txHash: null as string | null };
  switch (entry.action) {
    case "create_invoice": {
      const document = record(detail.document);
      return { ...base, who: "person", tone: "neutral", text: document ? "A person added it, read from a document." : "A person added it." };
    }
    case "recurring_invoice_created":
      return { ...base, who: "agent", tone: "neutral", text: "Its recurring schedule created it." };
    case "invoice_details_added": {
      const added = record(detail.added) ?? {};
      const what = [text(added.poReference) ? `purchase order ${text(added.poReference)}` : null, added.goodsReceived === true ? "goods received" : null]
        .filter((part): part is string => part !== null)
        .join(" and ");
      return { ...base, who: "person", tone: "neutral", text: `A person added ${what || "details"}.` };
    }
    case "invoice_reopened": {
      const changes = (record(detail.followUp)?.changes as unknown[] | undefined)?.filter((change): change is string => typeof change === "string") ?? [];
      return {
        ...base,
        who: "agent",
        tone: "neutral",
        text: changes.length > 0 ? "The agent saw the facts change and took it up again." : "The agent took it up again.",
        notes: changes.map((change) => `· ${change.charAt(0).toUpperCase()}${change.slice(1)}`),
      };
    }
    case "invoice_escalated":
      return { ...base, who: "agent", tone: "stopped", text: "The agent told the people who decide that it is still waiting." };
    case "ap_pay":
    case "ap_schedule":
    case "ap_hold":
    case "ap_request_info":
    case "ap_flag_fraud": {
      const decider = deciderName(detail.decisionMode);
      const agreed = detail.agreedWithReference;
      const policy = decider === "The written policy" ? "" : agreed === true ? ", as the written policy would" : agreed === false ? "; the written policy would have decided otherwise" : "";
      const code = codeNotes(detail);
      const execution = record(detail.execution);
      const tx = entry.action === "ap_pay" && !code.refused ? arcTx(execution?.txRef) : null;
      const paying = entry.action === "ap_pay" || entry.action === "ap_schedule";
      const stopped = code.refused || !paying || text(execution?.resultingStatus) === "held";
      return {
        ...base,
        who: "agent",
        tone: stopped ? "stopped" : "done",
        text: `${decider} decided ${VERBS[entry.action](detail)}${policy}.`,
        notes: [...checksOf(detail, paying), ...code.notes, ...(tx ? ["✓ Sent on Arc testnet"] : [])],
        txHash: tx,
      };
    }
    case "ap_reconcile": {
      const execution = record(detail.execution);
      const tx = arcTx(execution?.txRef) ?? arcTx(detail.txRef);
      return { ...base, who: "agent", tone: "done", text: "The agent confirmed the payment on Arc testnet.", txHash: tx };
    }
    case "approval_paid":
      return {
        ...base,
        who: "person",
        tone: "done",
        text: detail.soleApprover === true ? "The person who entered it approved and paid it, as the workspace's only approver." : "A person approved and paid it.",
        txHash: arcTx(detail.txRef),
      };
    case "approval_rejected":
      return { ...base, who: "person", tone: "stopped", text: "A person rejected it.", notes: text(detail.reason) ? [`· ${text(detail.reason)}`] : [] };
    case "approval_returned":
      return { ...base, who: "person", tone: "neutral", text: "A person returned it to the agent." };
    case "ar_received":
      return { ...base, who: "agent", tone: "done", text: "The agent matched the payment received on Arc testnet.", txHash: arcTx(detail.txHash) };
    case "ar_reminders_on":
      return { ...base, who: "person", tone: "neutral", text: "A person turned on the agent's reminders to the client." };
    case "ar_reminders_off":
      return { ...base, who: "person", tone: "neutral", text: "A person turned off the agent's reminders." };
    case "ar_reminder_sent": {
      const decider = deciderName(detail.decisionMode);
      const tone = text(detail.tone) ?? "friendly";
      const days = number(detail.daysFromDue);
      const when = days === null ? "" : days === 0 ? ", on the due date" : days < 0 ? `, ${-days} ${days === -1 ? "day" : "days"} before the due date` : `, ${days} ${days === 1 ? "day" : "days"} after the due date`;
      const limited = record(detail.toneLimited);
      return {
        ...base,
        who: "agent",
        tone: "done",
        text: `${decider} decided to remind the client by email, ${tone === "final" ? "a final reminder" : `in a ${tone} tone`}${when}${agreement(detail)}.`,
        notes: [
          ...(number(detail.number) !== null ? [`· Reminder ${number(detail.number)} of 4, sent to ${text(detail.to) ?? "the client's billing email"}`] : []),
          ...(limited ? [`✗ It chose a ${text(limited.chosen)} tone; code sent it ${text(limited.sent)}`] : []),
        ],
      };
    }
    case "ar_reminder_deferred": {
      const until = text(detail.until);
      return {
        ...base,
        who: "agent",
        tone: "neutral",
        text: `${deciderName(detail.decisionMode)} decided to wait${until ? ` until ${dayOf(until)}` : ""} before reminding the client${agreement(detail)}.`,
      };
    }
    default:
      return null;
  }
}

/**
 * The trail of one invoice, oldest first, from the entries about it (newest first, as `ledger_entries_for_targets`
 * returns them): the latest `TRAIL_STEPS_SHOWN` steps.
 */
export function invoiceTrail(entries: readonly TrailEntry[], invoiceId: string): TrailStep[] {
  const steps = entries
    .filter((entry) => entry.detail.invoiceId === invoiceId)
    .map(trailStep)
    .filter((step): step is TrailStep => step !== null)
    .sort((a, b) => a.seq - b.seq);
  return steps.slice(-TRAIL_STEPS_SHOWN);
}

/** How long after the step before it a step came: "26 s later", "4 min later", "2 h later"; null for the first, or a day or more. */
export function laterBy(previousAt: string | null, at: string): string | null {
  if (!previousAt) return null;
  const seconds = Math.round((Date.parse(at) - Date.parse(previousAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= 86_400) return null;
  if (seconds < 120) return `${seconds} s later`;
  if (seconds < 7_200) return `${Math.round(seconds / 60)} min later`;
  return `${Math.round(seconds / 3_600)} h later`;
}
