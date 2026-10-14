import type { FollowUp, Settlement } from "./settlement";

/**
 * Payments whose outcome is not clean (docs/superpowers/specs/2026-10-14-payment-exceptions-design.md). Pure words over
 * what is already recorded: what a person's pay action does with an earlier transfer, said before and while it runs
 * (E3), and the runbook each exceptional state is told with on the screens and in the guide (E5). Nothing here decides
 * a payment: `executePayment`, Approve and pay and Pay now keep their own rules, and only their words come from here.
 */

/** What a person's pay action does with the transfer an earlier attempt made (E3). */
export type PayAction =
  /** No earlier transfer: it sends the payment. */
  | "send"
  /** Circle ended the last attempt: it sends a new transfer, under a new attempt. */
  | "send_again"
  /** A transfer was sent and may still settle, or was confirmed, or Gateway reported it failed: it is only read again. */
  | "check"
  /** Circle never answered the send: it is looked for on Circle first, and sent only once Circle shows none. */
  | "look_first";

/** The last attempt as Approvals reports it (`LastPaymentAttempt`), by its shape. */
type Attempt = { state: "failed"; resend?: false } | { state: "in_flight" } | { state: "unanswered" } | null | undefined;

/** Approve and pay's action on a payable, from what Approvals lists of it (`paymentSent`, `lastAttempt`). */
export function payActionOf(payable: { paymentSent: boolean; lastAttempt?: Attempt }): PayAction {
  const attempt = payable.lastAttempt ?? null;
  if (attempt?.state === "unanswered") return "look_first";
  if (payable.paymentSent || attempt?.state === "in_flight" || (attempt?.state === "failed" && attempt.resend === false)) return "check";
  if (attempt?.state === "failed") return "send_again";
  return "send";
}

/** Pay now's action on a held milestone, by why it is held (`HeldReason.kind`). */
export function milestonePayAction(kind: string): PayAction {
  if (kind === "unknown") return "look_first";
  if (kind === "in_flight") return "check";
  if (kind === "transfer_failed") return "send_again";
  return "send";
}

/** Whether the action reads, or looks for, an earlier transfer before anything else: it then never says "pay now". */
export function checksFirst(action: PayAction): action is "check" | "look_first" {
  return action === "check" || action === "look_first";
}

/** The confirmation's title for an action that checks first, of `what` ("12.50 USDC to Jiren"); null for one that pays. */
export function checkFirstTitle(action: PayAction, what: string): string | null {
  if (action === "check") return `Check the payment of ${what} already sent?`;
  if (action === "look_first") return `Look for the earlier payment of ${what} first?`;
  return null;
}

/** The confirmation's button for an action that checks first. */
export const CHECK_FIRST_LABEL = { check: "Check it", look_first: "Look first" } as const;

/** What the notice raised while the action runs says of the money: sending, or checking the earlier transfer. */
export function runningLine(action: PayAction, payee: string): string {
  if (action === "check") return `Checking the transfer already sent to ${payee}`;
  if (action === "look_first") return `Looking for the earlier transfer to ${payee} on Circle first`;
  return `Sending to ${payee}`;
}

/** A chat confirmation's title for an action that checks first, kept within Slack's 100 characters by naming no payee. */
export const CHAT_CONFIRM_TITLE = { check: "Check the payment already sent?", look_first: "Look for the earlier payment first?" } as const;

/** What a chat's confirmation of Approve and pay says first, for an action that checks first; null for one that pays. */
export function chatConfirmText(action: PayAction): string | null {
  if (action === "check") return "Checks the transfer already sent with Circle and records it: nothing new is sent.";
  if (action === "look_first") return "Looks for the earlier transfer on Circle first: records it if Circle has it, and sends the payment only once Circle shows none.";
  return null;
}

/** The exceptional states a payment can be in, each with its runbook (E5). */
export type PaymentException = "stuck" | "unknown" | "failed" | "not_sent" | "gateway_failed";

/** One state's runbook: when it applies, who acts, what Vestiarion already did, what to do next, and where the trail is. */
export interface RunbookEntry {
  title: string;
  when: string;
  owner: string;
  done: string;
  next: string;
  trail: string;
}

/**
 * The runbook, state by state, as the guide lists it. "Returned or reversed" is not a state Arc has: it is in the guide
 * so no one looks for it, and never on a screen. People are named by role: owners, admins and approvers may approve
 * payments (`approval.decide`).
 */
export const RUNBOOK: Record<PaymentException | "returned", RunbookEntry> = {
  stuck: {
    title: "Slow to confirm",
    when: "Sent, and not confirmed by Circle after the network's wait: 15 minutes on Arc.",
    owner: "Owners, admins and approvers. Only Circle can move a transfer it holds.",
    done: "The transfer watch asks Circle about it once it is past the wait, records the answer in the audit log, and tells owners, admins and approvers by email, Slack, Telegram and webhooks. Nothing is sent again while it may still settle.",
    next: "Wait for Circle, and do not pay it another way: a slow transfer can still settle, and the next read records it. If it stays unconfirmed, contact Circle support with its Circle id.",
    trail: "Circle's word for it on Where the payment is, the transfer watch's entry in the decision trail and the audit log, its Circle id, and its transaction on the explorer once it has one.",
  },
  unknown: {
    title: "Outcome unknown",
    when: "Circle did not answer when the payment was sent, so it may or may not have taken the transfer.",
    owner: "Owners, admins and approvers.",
    done: "It is kept in flight, never counted as failed, and nothing is sent again until Circle answers. Past the network's wait, the transfer watch tells owners, admins and approvers that Circle never answered the send.",
    next: "Do not pay it another way: Vestiarion checks with Circle before anything is sent again.",
    trail: "The transfer watch's entry saying Circle never answered the send, in the decision trail and the audit log; once Circle lists it, its Circle id and its transaction.",
  },
  failed: {
    title: "Failed or cancelled",
    when: "Circle ended the transfer: FAILED or DENIED, on chain or before it, or CANCELLED. The payee was not paid.",
    owner: "Owners, admins and approvers. The agent never sends a failed payment again on its own.",
    done: "Circle's state and reason are recorded, and the bill is held for a person.",
    next: "Read Circle's reason and fix its cause first. A person sends it again, as a new transfer, from Approvals, or with Pay now on Contractors for a milestone.",
    trail: "Circle's state and reason on Where the payment is, and under Earlier attempts once it is sent again; each attempt's entry in the audit log; a transfer that failed on chain on the explorer, with the network fee it spent.",
  },
  not_sent: {
    title: "Not sent",
    when: "It stopped before Circle took the transfer: Circle refused the request, a check stopped it, or Circle listed nothing 15 minutes after a send it never answered. The payee was not paid.",
    owner: "Owners, admins and approvers.",
    done: "The reason is recorded, and the bill is held for a person. There is no transfer to look for.",
    next: "Read the recorded reason and fix it first. A person sends it from Approvals, or with Pay now on Contractors for a milestone.",
    trail: "The recorded reason on Where the payment is, and the decision's entry in the decision trail and the audit log.",
  },
  gateway_failed: {
    title: "Gateway reported it failed",
    when: "A payout to another chain through Circle Gateway that Gateway reported failed. Its attestation may still be minted on the payee's chain.",
    owner: "Owners, admins and approvers, in Approvals.",
    done: "Gateway's word is recorded and nothing is sent again. Nothing checks it on its own.",
    next: "Check with Circle whether it was minted on the payee's chain. If it was, Approve and pay records it; if it was not, reject the invoice or return it to the agent.",
    trail: "Gateway's word on Where the payment is, its Circle id, and the decision's entry in the decision trail and the audit log.",
  },
  returned: {
    title: "Returned or reversed",
    when: "Arc has no such state: a USDC transfer Circle confirmed is final, and cannot be charged back, reversed or returned by the network.",
    owner: "Owners and admins.",
    done: "Nothing: there is no state to watch.",
    next: "Agree any refund with the payee. Money they send back arrives as a new transfer into the operating wallet, a separate payment; the original payment stays paid.",
    trail: "The original payment keeps its track, receipt and transaction; the money sent back is its own transaction on the explorer.",
  },
};

/** The guide's heading for each state, where the screens link it. */
export const EXCEPTION_ANCHOR: Record<PaymentException | "returned", string> = {
  stuck: "slow-to-confirm",
  unknown: "outcome-unknown",
  failed: "failed-or-cancelled",
  not_sent: "not-sent",
  gateway_failed: "gateway-reported-it-failed",
  returned: "returned-or-reversed",
};

/** The runbook's page, or one state's section of it. */
export function runbookHref(state?: PaymentException | "returned"): string {
  return state ? `/docs/guides/payment-exceptions#${EXCEPTION_ANCHOR[state]}` : "/docs/guides/payment-exceptions";
}

/** Circle's own `STUCK` state: the next step is Circle's (stuck-transfer alert D7). */
export const STUCK_AT_CIRCLE =
  "Circle shows it stuck: check it in Circle's console, or contact Circle support with its Circle id. Do not pay it another way: it can still be mined.";

/** Who reads a payment in flight again, by who comes back to its bill (settlement lifecycle L5, L10). */
export const READS_AGAIN: Record<FollowUp, string> = {
  cycle: "The agent's next cycle reads it again.",
  approvals: "Approve and pay in Approvals reads it again, and sends nothing new.",
  contractors: "Pay now on Contractors reads it again, and sends nothing new.",
};

/** Who acts, where it differs by who comes back to the bill. */
export const OWNER_BY_FOLLOW_UP: { unknown: Record<FollowUp, string> } = {
  unknown: {
    cycle: "The agent: each cycle checks with Circle before anything is sent again.",
    approvals: "Owners, admins and approvers, in Approvals.",
    contractors: "Owners, admins and approvers, on Contractors.",
  },
};

/** What to do next, where it differs by who comes back to the bill. */
export const NEXT_BY_FOLLOW_UP: {
  unknown: Record<FollowUp, string>;
  failed: Record<"approvals" | "contractors", string>;
  not_sent: Record<"approvals" | "contractors", string>;
} = {
  unknown: {
    cycle: "Wait, and do not pay it another way. If the agent is paused, resume it: each cycle checks with Circle before anything is sent again.",
    approvals: "Press Approve and pay in Approvals: it checks with Circle for the earlier transfer first, records it if Circle has it, and never sends it twice. Reject and Return check first too. If it says to try again from a time, try again then.",
    contractors: "Press Pay now on Contractors: it checks with Circle for the earlier transfer first, records it if Circle has it, and never sends it twice. Close without paying checks first too. If it says to try again from a time, try again then.",
  },
  failed: {
    approvals: "Read Circle's reason on the card and fix its cause first, such as adding USDC to the operating wallet. Then Approve and pay in Approvals sends a new transfer, under a new attempt; or reject it, or return it to the agent.",
    contractors: "Read Circle's reason and fix its cause first, such as adding USDC to the operating wallet. Then Pay now on Contractors sends a new transfer, under a new attempt; or close it without paying.",
  },
  not_sent: {
    approvals: "Read the recorded reason and fix it first, such as a payee with no address. Then Approve and pay in Approvals sends it; or reject it, or return it to the agent.",
    contractors: "Read the recorded reason and fix it first, such as a contractor with no address. Then Pay now on Contractors sends it; or close it without paying.",
  },
};

/**
 * A payout to another chain whose send Circle never answered (payment exceptions review 5): Circle cannot list it by the
 * payment's reference, so nothing looks it up; it is asked for again under the same payment key, which Circle takes only
 * once, and Reject and Return wait until Circle has answered.
 */
export const ACROSS_CHAINS: { done: string; next: Record<"cycle" | "approvals", string> } = {
  done: "It is kept in flight, never counted as failed. A payout to another chain cannot be looked up on Circle by its reference: it is asked for again under the same payment key, which Circle takes only once, so it is never paid twice. Past the network's wait, the transfer watch tells owners, admins and approvers that Circle never answered the send.",
  next: {
    cycle: "Wait, and do not pay it another way. If the agent is paused, resume it: each cycle asks Circle for the payout again under the same payment key.",
    approvals: "Press Approve and pay in Approvals: it asks Circle for the payout again under the same payment key, which Circle takes only once, and records what Circle answers. Reject and Return wait until Circle has answered: if it should not be paid, ask Circle support whether it took the payout first.",
  },
};

/**
 * The exceptional state a payment is in, from its lifecycle, or null: slow to confirm once in flight for the network's
 * wait or longer (Treasury's own count), an unknown outcome however young, an end, or Gateway's failure.
 */
export function paymentException(settlement: Pick<Settlement, "status" | "inFlightSince">, now: number, stuckAfterMinutes: number): PaymentException | null {
  switch (settlement.status) {
    case "unknown":
      return "unknown";
    case "failed":
    case "cancelled":
      return "failed";
    case "not_sent":
      return "not_sent";
    case "gateway_failed":
      return "gateway_failed";
    case "in_flight":
      return settlement.inFlightSince && now - Date.parse(settlement.inFlightSince) >= stuckAfterMinutes * 60_000 ? "stuck" : null;
    default:
      return null;
  }
}

/**
 * Whether anyone has something to do about it: money that may still move always; an end, or Gateway's failure, only
 * while a person comes back to its bill. Rejected, closed or paid since, there is nothing left to do.
 */
export function needsSomeone(exception: PaymentException, followUp: FollowUp | null): boolean {
  if (exception === "stuck" || exception === "unknown") return true;
  return followUp === "approvals" || followUp === "contractors";
}

export interface WhatToDo {
  state: PaymentException;
  title: string;
  owner: string;
  done: string;
  next: string;
  trail: string;
}

/**
 * One state's runbook for this payment: who acts and what to do next follow who comes back to its bill, and, for an
 * unknown outcome, whether it is a payout to another chain, which is asked for again rather than looked up.
 */
export function whatToDo(state: PaymentException, context: { followUp: FollowUp | null; circleState?: string | null; crossChain?: boolean }): WhatToDo {
  const entry = RUNBOOK[state];
  const { followUp } = context;
  const base = { state, title: entry.title, owner: entry.owner, done: entry.done, next: entry.next, trail: entry.trail };
  switch (state) {
    case "stuck":
      return { ...base, done: followUp ? `${entry.done} ${READS_AGAIN[followUp]}` : entry.done, next: context.circleState === "STUCK" ? STUCK_AT_CIRCLE : entry.next };
    case "unknown": {
      const owned = followUp ? { ...base, owner: OWNER_BY_FOLLOW_UP.unknown[followUp], next: NEXT_BY_FOLLOW_UP.unknown[followUp] } : base;
      if (!context.crossChain) return owned;
      const next = followUp === "cycle" || followUp === "approvals" ? ACROSS_CHAINS.next[followUp] : owned.next;
      return { ...owned, done: ACROSS_CHAINS.done, next };
    }
    case "failed":
    case "not_sent":
      return followUp === "approvals" || followUp === "contractors" ? { ...base, next: NEXT_BY_FOLLOW_UP[state][followUp] } : base;
    case "gateway_failed":
      return base;
  }
}

/** Treasury's one line of what to do for a payment in flight that is slow to confirm or of unknown outcome. */
export function inFlightNext(state: "stuck" | "unknown", context: { followUp: FollowUp | null; circleState?: string | null; crossChain?: boolean }): string {
  if (state === "stuck") return context.circleState === "STUCK" ? "Circle shows it stuck: check it with Circle support. Do not pay it another way." : "Wait for Circle, and do not pay it another way.";
  // A payout to another chain is asked for again under its key, never looked up (review 5).
  if (context.crossChain && context.followUp === "cycle") return "Wait, and do not pay it another way: the agent's next cycle asks Circle again under the same payment key.";
  if (context.crossChain && context.followUp === "approvals") return "Approve and pay in Approvals: it asks Circle again under the same payment key, which Circle takes only once.";
  switch (context.followUp) {
    case "cycle":
      return "Wait, and do not pay it another way: the agent's next cycle looks for it.";
    case "approvals":
      return "Approve and pay in Approvals: it looks for it first and sends nothing twice.";
    case "contractors":
      return "Pay now on Contractors: it looks for it first and sends nothing twice.";
    default:
      return "Do not pay it another way.";
  }
}
