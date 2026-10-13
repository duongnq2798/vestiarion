/**
 * How the agent decided a payable, step by step, from the signed entries about it (decision trail, spec
 * 2026-10-03-decision-trail-design): who added it, what a person changed, what the model decided and whether the
 * written policy agreed, what code and the spending-limit contract checked, and what reached Arc. Pure: the page
 * hands it the entries it already read.
 */

import { networkProfile, type Network } from "./network";
import { MIRROR } from "./new-payee";

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

/** An amount and its currency, as an entry about money received records them. */
const coins = (amount: unknown, currency: unknown) => `${AMOUNT.format(number(amount) ?? 0)} ${text(currency) ?? "USDC"}`;

/** What an application left: owed on the invoice, and of the payment. */
function owedNotes(detail: Record<string, unknown>): string[] {
  const owed = number(detail.outstandingAfter);
  const left = number(detail.unappliedAfter);
  return [
    ...(owed === null ? [] : owed === 0 ? ["✓ Nothing is owed on it now"] : [`· ${coins(owed, detail.currency)} still owed`]),
    ...(left !== null && left > 0 ? [`· ${coins(left, detail.currency)} of the payment left to apply`] : []),
  ];
}

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
    const goods = observed.goodsReceived === true;
    // A counterparty paid without purchase orders needs none: its match is the goods received (three-way match design M4).
    const waived = !po && observed.purchaseOrderRequired === false;
    notes.push(
      waived
        ? `${goods ? "✓ The goods received" : "✗ The goods not marked received"}; no purchase order needed for this counterparty`
        : po && goods
          ? `✓ Purchase order ${po} on file and the goods received`
          : `✗ ${po ? `Purchase order ${po} on file, but the goods not marked received` : "No purchase order on file"}`
    );
  }
  // The first payment to an address, and whether two people stood behind it (new payee check N6).
  const newPayee = record(observed.newPayee);
  if (newPayee) {
    notes.push(
      // A mirror address is a wallet Vestiarion made in shadow mode: no person gave it (shadow mode S7).
      newPayee.addressBy === MIRROR
        ? "✓ First payment to this address, a mirror address Vestiarion made in shadow mode"
        : newPayee.twoParties === true
          ? "✓ First payment to this address, with two people behind it"
          : "✗ First payment to this address, and only one person stands behind it"
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

/**
 * What was checked about a decision, one short line each, marked passed or not: its facts, then what code and the
 * spending-limit contract said. The trail's notes without what it sent; the evidence chain shows them on its decision
 * step (evidence chain E2), so the two never word a check differently.
 */
export function decisionChecks(detail: Record<string, unknown>, paying: boolean): { notes: string[]; refused: boolean } {
  const code = codeNotes(detail);
  return { notes: [...checksOf(detail, paying), ...code.notes], refused: code.refused };
}

/** ", as the written policy would", or how the model departed from it; nothing for the written policy itself. */
function agreement(detail: Record<string, unknown>): string {
  if (deciderName(detail.decisionMode) === "The written policy") return "";
  return detail.agreedWithReference === true ? ", as the written policy would" : detail.agreedWithReference === false ? "; the written policy would have decided otherwise" : "";
}

/** What a collection task asked, by its reason (collections context C6). */
const COLLECTION_TASK_WORDS: Record<string, string> = {
  policy_ask_first: "the customer's rules say to ask first",
  hubspot_owner: "its HubSpot deal has an owner, who may have given more time",
  no_contact: "the customer has no billing email",
  promise_passed: "the customer's promised day passed",
  claim_unverified: "the customer says it paid, and the payment is still not found a week later",
  reminders_done: "the agent's reminders are done",
};

/** One entry as a step, or null for one the trail does not show (receipts, links). */
export function trailStep(entry: TrailEntry, network: Network = "arc-testnet"): TrailStep | null {
  // The viewed workspace's network, old entries included: steps are rebuilt on every view (mainnet copy C4).
  const { label } = networkProfile(network);
  const detail = entry.detail;
  const base = { seq: entry.seq, at: entry.ts, notes: [] as string[], txHash: null as string | null };
  switch (entry.action) {
    case "create_invoice": {
      const document = record(detail.document);
      const from = document
        ? ", read from a document"
        : detail.via === "import"
          ? ", imported from a list"
          : detail.via === "xero"
            ? ", brought in from Xero"
            : detail.via === "quickbooks"
              ? ", brought in from QuickBooks"
              : "";
      return { ...base, who: "person", tone: "neutral", text: `A person added it${from}.` };
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
      const paying = entry.action === "ap_pay" || entry.action === "ap_schedule";
      const code = decisionChecks(detail, paying);
      const execution = record(detail.execution);
      const tx = entry.action === "ap_pay" && !code.refused ? arcTx(execution?.txRef) : null;
      const stopped = code.refused || !paying || text(execution?.resultingStatus) === "held";
      return {
        ...base,
        who: "agent",
        tone: stopped ? "stopped" : "done",
        text: `${decider} decided ${VERBS[entry.action](detail)}${policy}.`,
        notes: [...code.notes, ...(tx ? [`✓ Sent on ${label}`] : [])],
        txHash: tx,
      };
    }
    case "ap_reconcile": {
      const execution = record(detail.execution);
      const tx = arcTx(execution?.txRef) ?? arcTx(detail.txRef);
      // As it found the payment (stuck-transfer alert D8): confirmed only when it was paid.
      const resulting = text(execution?.resultingStatus);
      if (resulting === "paid") return { ...base, who: "agent", tone: "done", text: `The agent confirmed the payment on ${label}.`, txHash: tx };
      if (resulting === "matched") return { ...base, who: "agent", tone: "neutral", text: `The agent checked the payment: still in flight on ${label}.`, txHash: tx };
      // Held for a person, never "did not go through": a payout across chains is held with its USDC already sent (final
      // review M3), and saying otherwise could prompt a second payment.
      if (resulting === "held") return { ...base, who: "agent", tone: "stopped", text: "The agent checked the payment and held the invoice for a person.", txHash: tx };
      return { ...base, who: "agent", tone: "neutral", text: `The agent checked the payment on ${label}.`, txHash: tx };
    }
    case "payment_stuck":
      return {
        ...base,
        who: "agent",
        tone: "stopped",
        // Submitted, never "sent": Circle may not have taken it (settlement lifecycle I17).
        text: `Not confirmed ${number(detail.minutes) ?? 0} minutes after it was submitted; the workspace's people were told.`,
        txHash: arcTx(detail.txHash),
      };
    case "approval_paid":
      // Paid only once its transfer confirmed: sent, failed, or not said by an entry that recorded no status (settlement
      // lifecycle L9). The step says what the transfer did when the person approved it; the payment's own stages follow it.
      return { ...base, who: "person", ...approvalStep(text(detail.status), detail.soleApprover === true, label), txHash: arcTx(detail.txRef) };
    case "approval_rejected":
      return { ...base, who: "person", tone: "stopped", text: "A person rejected it.", notes: text(detail.reason) ? [`· ${text(detail.reason)}`] : [] };
    case "approval_returned":
      return { ...base, who: "person", tone: "neutral", text: "A person returned it to the agent." };
    // A person moved the day it is decided again on, from the payment plan (payment plan design P9): not a decision.
    case "payment_rescheduled": {
      const to = text(detail.to);
      return {
        ...base,
        who: "person",
        tone: "neutral",
        text: to
          ? `A person moved its payment to ${dayOf(to)} from the payment plan${detail.soleApprover === true ? ", as the workspace's only approver" : ""}.`
          : "A person moved its payment from the payment plan.",
        notes: ["· The agent checks it again on that day before it pays"],
      };
    }
    case "ar_received":
      return { ...base, who: "agent", tone: "done", text: `The agent matched the payment received on ${label}.`, txHash: arcTx(detail.txHash) };
    // A payment applied, a fee and a reversal (allocations L12): one step per row.
    case "ar_payment_applied": {
      const money = coins(detail.amount, detail.currency);
      const byAgent = entry.actor === "agent";
      return {
        ...base,
        who: byAgent ? "agent" : "person",
        tone: "done",
        text: byAgent
          ? `The agent applied ${money} received on ${label}: what was still owed.`
          : `A person applied ${money} received on ${label}${record(detail.suggestion) ? ", as the agent suggested" : ""}.`,
        notes: owedNotes(detail),
        txHash: arcTx(detail.txHash),
      };
    }
    case "ar_fee_recorded":
      return { ...base, who: "person", tone: "neutral", text: `A person recorded ${coins(detail.amount, detail.currency)} as a fee: ${text(detail.reason) ?? "no reason given"}.`, notes: owedNotes(detail) };
    case "ar_allocation_reversed":
      return {
        ...base,
        who: "person",
        tone: "stopped",
        text: `A person reversed ${coins(detail.amount, detail.currency)} ${detail.reversedKind === "fee" ? "recorded as a fee" : "applied"}: ${text(detail.reason) ?? "no reason given"}.`,
        notes: owedNotes(detail),
      };
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
      const toneWords = tone === "final" ? "a final reminder" : `in a ${tone} tone`;
      return {
        ...base,
        who: "agent",
        tone: "done",
        // A reminder a person approved from a collection task went without the model (collections context C6).
        text:
          detail.decisionMode === "person"
            ? `A person approved the reminder, and the agent sent it to the client by email, ${toneWords}${when}.`
            : `${decider} decided to remind the client by email, ${toneWords}${when}${agreement(detail)}.`,
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
    // What the collections stage asked a person, and their answer (collections context C6).
    case "collection_task_opened":
      return { ...base, who: "agent", tone: "neutral", text: `The agent asked a person before going on: ${COLLECTION_TASK_WORDS[text(detail.reason) ?? ""] ?? "a person decides the next step"}.` };
    case "collection_task_resolved": {
      const until = text(detail.holdUntil);
      const reminder = record(detail.reminder);
      const outcome = text(detail.outcome);
      // A claim's review marks the customer's claim not received first, whichever way it goes.
      const claim = text(detail.reason) === "claim_unverified" ? "marked the customer's claim of payment not received and " : "";
      const said =
        outcome === "approved"
          ? `approved reminder ${number(reminder?.number) ?? ""}${text(reminder?.tone) ? `, ${text(reminder?.tone)}` : ""}`.replace(" ,", ",")
          : outcome === "held"
            ? `${claim}held reminders${until ? ` until ${dayOf(until)}` : ""}`
            : outcome === "no_reminder"
              ? "turned reminders off for this invoice"
              : outcome === "resumed"
                ? claim
                  ? `${claim}let reminders go again`
                  : "closed the promise and let reminders go again"
                : "marked it done";
      return { ...base, who: "person", tone: "neutral", text: `A person ${said}.` };
    }
    // What the customer said on its statement, and a person's answer (customer portal P10): its word, never a payment.
    case "customer_said_paid": {
      const paidOn = text(detail.paidOn);
      const amount = number(detail.amount);
      return {
        ...base,
        who: "person",
        tone: "neutral",
        text: `The customer said on its statement that it paid${amount !== null ? ` ${coins(amount, detail.currency)}` : ""}${paidOn ? ` on ${dayOf(paidOn)}` : ""}.`,
        notes: [
          "· Its word, not a payment: the invoice stays open until the money arrives and is applied",
          "· The agent's reminders wait until a person finds it or marks it not received; finance is asked after 7 days",
        ],
      };
    }
    case "customer_promised_payment": {
      const promisedOn = text(detail.promisedOn);
      return {
        ...base,
        who: "person",
        tone: "neutral",
        text: `The customer promised on its statement to pay${promisedOn ? ` by ${dayOf(promisedOn)}` : ""}.`,
        notes: ["· The agent's reminders wait through that day; once it passes, finance reviews it before any reminder"],
      };
    }
    case "customer_disputed_invoice":
      return { ...base, who: "person", tone: "stopped", text: "The customer disputed the invoice on its statement.", notes: ["· The agent's reminders wait until a person resolves it"] };
    case "customer_asked_pay_link":
      return { ...base, who: "person", tone: "neutral", text: "The customer asked on its statement for a pay link." };
    case "customer_wrote":
      return { ...base, who: "person", tone: "neutral", text: "The customer wrote more on its statement." };
    case "customer_request_replied":
      return { ...base, who: "person", tone: "neutral", text: "A person replied to the customer on its statement." };
    case "customer_request_closed": {
      const what = { paid: "claim of payment", promise: "promise to pay", dispute: "dispute", pay_link: "request for a pay link" }[text(detail.kind) ?? ""] ?? "request";
      const outcome = text(detail.outcome) === "not_received" ? "not received" : detail.kind === "paid" ? "payment found" : "resolved";
      return { ...base, who: "person", tone: "neutral", text: `A person closed the customer's ${what}: ${outcome}.` };
    }
    default:
      return null;
  }
}

/**
 * The trail of one invoice, oldest first, from the entries about it (newest first, as `ledger_entries_for_targets`
 * returns them): the latest `TRAIL_STEPS_SHOWN` steps.
 */
export function invoiceTrail(entries: readonly TrailEntry[], invoiceId: string, network: Network = "arc-testnet"): TrailStep[] {
  const steps = entries
    .filter((entry) => entry.detail.invoiceId === invoiceId)
    .map((entry) => trailStep(entry, network))
    .filter((step): step is TrailStep => step !== null)
    .sort((a, b) => a.seq - b.seq);
  return steps.slice(-TRAIL_STEPS_SHOWN);
}

/**
 * A person's Approve and pay as a step, by what its transfer did then (`approval_paid`'s `status`). `held` never says the
 * transfer failed: the entry does not say whether Circle ended it, or Gateway reported it failed though it may still be
 * minted, or a read of Vestiarion's failed on a transfer still moving (settlement lifecycle L3, L9).
 */
function approvalStep(status: string | null, sole: boolean, network: string): Pick<TrailStep, "text" | "tone"> {
  const who = sole ? "The person who entered it" : "A person";
  const own = sole ? ", as the workspace's only approver" : "";
  if (status === "paid") return { tone: "done", text: `${who} approved and paid it${own}.` };
  if (status === "matched") return { tone: "neutral", text: `${who} approved it${own}; ${PAYMENT_SUBMITTED(network)}.` };
  if (status === "held") return { tone: "stopped", text: `${who} approved it${own}; ${PAYMENT_HELD_AGAIN}.` };
  return { tone: "neutral", text: `${who} approved paying it${own}.` };
}

/** What a person's approval says of a payment it submitted that Circle has not confirmed yet: submitted, never "sent" (I17). */
export const PAYMENT_SUBMITTED = (network: string) => `the payment was submitted and is waiting for Circle to confirm it on ${network}`;
/** What it says of one held again: not confirmed, whatever became of its transfer. */
export const PAYMENT_HELD_AGAIN = "the payment was not confirmed, so it was held again";

/** How long after the step before it a step came: "26 s later", "4 min later", "2 h later"; null for the first, or a day or more. */
export function laterBy(previousAt: string | null, at: string): string | null {
  if (!previousAt) return null;
  const seconds = Math.round((Date.parse(at) - Date.parse(previousAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= 86_400) return null;
  if (seconds < 120) return `${seconds} s later`;
  if (seconds < 7_200) return `${Math.round(seconds / 60)} min later`;
  return `${Math.round(seconds / 3_600)} h later`;
}
