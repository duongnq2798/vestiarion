import { utcDay } from "../copy";
import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email that tells the members who can decide payments that held payables passed the day they had to be decided
 * by (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md E4), or reached the last day before a late fee
 * (late fees LF5): one message per member, each payable once per decide-by day. The look of `actionEmailHtml`; every
 * value escaped; no address, wallet or email of anyone.
 */

export interface EscalationItem {
  counterpartyName: string;
  amount: number;
  /** USDC unless the payable is in EURC. */
  currency: string;
  status: "held" | "flagged" | "awaiting_info";
  /** `YYYY-MM-DD`. */
  decideBy: string;
  /** The decide-by day was the early-payment discount's deadline. */
  discount: boolean;
  /**
   * The decide-by day was the last before a late fee (late fees LF5): its first day, its rate in words, and whether it
   * has started. Absent otherwise.
   */
  lateFee?: { startsOn: string; rate: string; started: boolean };
}

export const ESCALATION_MAX_ITEMS = 10;

const STATUS: Record<EscalationItem["status"], string> = { held: "Held", flagged: "Flagged", awaiting_info: "Waiting for information" };

const amountWords = (amount: number, currency: string) =>
  `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(amount)} ${currency}`;

const dayWords = (day: string) => utcDay(`${day}T00:00:00.000Z`);

/** Why its day, when it says more than the day: the discount, or the late fee that starts the next day or already has. */
function whyWords(item: EscalationItem): string {
  if (item.discount) return " to keep its discount";
  if (!item.lateFee) return "";
  const { startsOn, rate, started } = item.lateFee;
  return started ? `; a late fee of ${rate} applies since ${dayWords(startsOn)}` : `, before a late fee of ${rate} starts ${dayWords(startsOn)}`;
}

const itemWords = (item: EscalationItem) =>
  `${item.counterpartyName}: ${amountWords(item.amount, item.currency)}, ${STATUS[item.status]}, to decide by ${dayWords(item.decideBy)}${whyWords(item)}`;

export function decisionEscalationEmail(input: { orgName: string; items: EscalationItem[]; link: string; origin: string }): { subject: string; html: string; text: string } {
  const { orgName, items, link, origin } = input;
  const n = items.length;
  const payments = `${n} payment${n === 1 ? "" : "s"}`;
  // A payment on the last day before its late fee has not passed its day: the email says the day was reached (LF5).
  const reached = items.some((item) => item.lateFee && !item.lateFee.started);
  const subject = `${payments} ${reached ? "reached" : "passed"} ${n === 1 ? "its" : "their"} decide-by day in ${orgName}`;
  const opening = reached
    ? `reached the day ${n === 1 ? "it is" : "they are"} to be decided by`
    : `passed the day ${n === 1 ? "it was" : "they were"} to be decided by`;
  const shown = items.slice(0, ESCALATION_MAX_ITEMS);
  const more = n - shown.length;
  const footer = `You get this because you can approve payments in ${orgName}. You can turn these emails off in Settings, under Notifications.`;
  const html = actionEmailHtml({
    title: reached ? "Payments at their decide-by day" : "Payments past their decide-by day",
    preheader: `${payments} in ${orgName} ${reached ? "reached" : "waited past"} the day to decide ${n === 1 ? "it" : "them"}.`,
    eyebrow: reached ? "The day to decide" : "Past the day to decide",
    heading: `${payments} still ${n === 1 ? "waits" : "wait"} for a decision`,
    paragraphsHtml: [
      `${n === 1 ? "This payment" : "These payments"} in <strong style="color:#18211c;">${escapeHtml(orgName)}</strong> ${opening}. Approve, reject or return each one to the agent.`,
      ...shown.map((item) => escapeHtml(itemWords(item))),
      ...(more > 0 ? [`and ${more} more`] : []),
    ],
    button: { label: "Open Approvals", link },
    note: footer,
    origin,
  });
  const text = [
    `${payments} in ${orgName} ${opening}. Approve, reject or return each one to the agent.`,
    "",
    ...shown.map((item) => `- ${itemWords(item)}`),
    ...(more > 0 ? [`and ${more} more`] : []),
    "",
    "Open Approvals:",
    link,
    "",
    footer,
  ].join("\n");
  return { subject, html, text };
}
