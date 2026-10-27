import { approvalAnchor } from "../auth/org-paths";
import { firstSentence } from "../email/waiting-digest";
import { codeStoppedLine } from "../next-step";
import { presentReasoning } from "../reasoning-copy";
import { needsTwoApprovals } from "../two-approvals";

/**
 * The bills a chat is told wait for approval (docs/superpowers/specs/2026-10-22-discord-design.md DC3), as structured
 * entries a channel formats in its own markup: Discord's notice, and the section of Telegram's and Slack's decisions
 * messages. Each says how much, to whom, why it stopped (the rule, when code stopped it, as its row on Bills says it,
 * else the agent's first plain sentence), whether it needs two approvals and an accountant may give one, and the
 * Approvals path that opens it. The path carries no token: opening it approves nothing. Pure.
 */

/** At most this many bills are listed one by one; the rest are counted. */
export const NOTICE_MAX_BILLS = 10;

/** A payable the agent stopped for a person, as the stage re-read it. */
export interface WaitingBill {
  id: string;
  payee: string;
  amount: number;
  currency: "USDC" | "EURC";
  status: "held" | "flagged" | "awaiting_info";
  /** The agent's reasoning, as stored on the invoice. */
  reasoning: string | null;
  /**
   * The rule code stopped it on, from its latest AP decision (`stopRuleOf`): a guardrail rule or the cash shortfall hold;
   * null when code did not stop it, or that could not be read.
   */
  stopRule: string | null;
  /** A EURC bill's USDC value as the agent last weighed it; null when it is not known. */
  usdcValue?: number | null;
}

/** The workspace's rules that change what a bill needs (two approvals T1, accountant co-sign CS1). */
export interface NoticePolicy {
  /** The figure above which a payment needs two approvals; null when none is set. */
  twoApprovalsAbove: number | null;
  /** Whether accountants co-sign bills above the figure. */
  accountantCosigns: boolean;
}

export interface WaitingNoticeEntry {
  invoiceId: string;
  payee: string;
  /** "1,250.00 USDC". */
  amountText: string;
  status: WaitingBill["status"];
  /**
   * Why it stopped: "Code stopped it: …" when code did (chat code stop reason CS3), else the first sentence of the agent's
   * reasoning, as the approval card says it; null when it gave none.
   */
  reason: string | null;
  /** Above the figure for two approvals. */
  twoApprovals: boolean;
  /** One of those two approvals may be an accountant's co-sign. */
  cosign: boolean;
  /** The org path of the bill's card on Approvals, `/approvals#payable-<id>`. */
  reviewPath: string;
}

export interface WaitingNotice {
  /** At most `NOTICE_MAX_BILLS`, in the order given. */
  entries: WaitingNoticeEntry[];
  /** How many more wait than are listed. */
  more: number;
  /** Every bill given, listed or not. */
  total: number;
}

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export function buildWaitingNotice(items: readonly WaitingBill[], policy: NoticePolicy = { twoApprovalsAbove: null, accountantCosigns: false }): WaitingNotice {
  const entries = items.slice(0, NOTICE_MAX_BILLS).map((item): WaitingNoticeEntry => {
    const twoApprovals = needsTwoApprovals({ amount: item.amount, currency: item.currency, usdcValue: item.usdcValue ?? null }, policy.twoApprovalsAbove);
    return {
      invoiceId: item.id,
      payee: item.payee,
      amountText: `${AMOUNT.format(item.amount)} ${item.currency}`,
      status: item.status,
      // What code stopped it on, as its row on Bills says it: the model's sentence may say it pays (CS3). Else as the
      // approval card and the email digest say it: plain sentences, never the model's field names (plain reasoning R4).
      reason: codeStoppedLine(item.stopRule) ?? firstSentence(presentReasoning(item.reasoning) || null),
      twoApprovals,
      cosign: twoApprovals && policy.accountantCosigns,
      reviewPath: `/approvals#${approvalAnchor(item.id)}`,
    };
  });
  return { entries, more: items.length - entries.length, total: items.length };
}
