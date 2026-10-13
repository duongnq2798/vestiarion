import { utcDay } from "../copy";
import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email that tells the members who can decide payments that held payables passed the day they had to be decided
 * by (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md E4): one message per member, each payable once
 * per decide-by day. The look of `actionEmailHtml`; every value escaped; no address, wallet or email of anyone.
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
}

export const ESCALATION_MAX_ITEMS = 10;

const STATUS: Record<EscalationItem["status"], string> = { held: "Held", flagged: "Flagged", awaiting_info: "Waiting for information" };

const amountWords = (amount: number, currency: string) =>
  `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(amount)} ${currency}`;

const itemWords = (item: EscalationItem) =>
  `${item.counterpartyName}: ${amountWords(item.amount, item.currency)}, ${STATUS[item.status]}, to decide by ${utcDay(`${item.decideBy}T00:00:00.000Z`)}${item.discount ? " to keep its discount" : ""}`;

export function decisionEscalationEmail(input: { orgName: string; items: EscalationItem[]; link: string; origin: string }): { subject: string; html: string; text: string } {
  const { orgName, items, link, origin } = input;
  const n = items.length;
  const payments = `${n} payment${n === 1 ? "" : "s"}`;
  const subject = `${payments} passed ${n === 1 ? "its" : "their"} decide-by day in ${orgName}`;
  const shown = items.slice(0, ESCALATION_MAX_ITEMS);
  const more = n - shown.length;
  const footer = `You get this because you can approve payments in ${orgName}. You can turn these emails off in Settings, under Notifications.`;
  const html = actionEmailHtml({
    title: "Payments past their decide-by day",
    preheader: `${payments} in ${orgName} waited past the day to decide ${n === 1 ? "it" : "them"}.`,
    eyebrow: "Past the day to decide",
    heading: `${payments} still ${n === 1 ? "waits" : "wait"} for a decision`,
    paragraphsHtml: [
      `${n === 1 ? "This payment" : "These payments"} in <strong style="color:#18211c;">${escapeHtml(orgName)}</strong> passed the day ${n === 1 ? "it was" : "they were"} to be decided by. Approve, reject or return each one to the agent.`,
      ...shown.map((item) => escapeHtml(itemWords(item))),
      ...(more > 0 ? [`and ${more} more`] : []),
    ],
    button: { label: "Open Approvals", link },
    note: footer,
    origin,
  });
  const text = [
    `${payments} in ${orgName} passed the day ${n === 1 ? "it was" : "they were"} to be decided by. Approve, reject or return each one to the agent.`,
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
