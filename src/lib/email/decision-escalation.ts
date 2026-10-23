import { utcDay } from "../copy";
import { lateFeeDayWords } from "../exceptions";
import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email that tells the members who can decide payments that held payables passed the day they had to be decided
 * by (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md E4), or that a held payable's late fee starts
 * tomorrow (late fees LF5): one message per member, each payable once per decide-by day. Each payable is worded on its
 * own. The look of `actionEmailHtml`; every value escaped; no address, wallet or email of anyone.
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
   * The payable's late fee, for one past its due date that has one (late fees LF5): its first day, its rate in words, and
   * whether it has started. Absent otherwise.
   */
  lateFee?: { startsOn: string; rate: string; started: boolean };
  /**
   * Told on its late fee's eve, the last day without the fee (LF5): `decideBy` is that day, today, and the fee starts
   * tomorrow. Absent for a payable past its decide-by day.
   */
  eve?: boolean;
}

export const ESCALATION_MAX_ITEMS = 10;

const STATUS: Record<EscalationItem["status"], string> = { held: "Held", flagged: "Flagged", awaiting_info: "Waiting for information" };

const amountWords = (amount: number, currency: string) =>
  `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(amount)} ${currency}`;

const dayWords = (day: string) => utcDay(`${day}T00:00:00.000Z`);

/**
 * What its day says besides the day: the discount; the late fee, as the decide-by words name it; or, on the fee's eve,
 * that it starts tomorrow.
 */
function whyWords(item: EscalationItem): string {
  if (item.discount) return " to keep its discount";
  if (!item.lateFee) return "";
  if (item.eve) return `, before a late fee of ${item.lateFee.rate} starts tomorrow, ${dayWords(item.lateFee.startsOn)}`;
  return `; ${lateFeeDayWords(item.lateFee)}`;
}

const passedWords = (count: number) => `passed the day ${count === 1 ? "it was" : "they were"} to be decided by`;
const feeTomorrowWords = (count: number) => `${count === 1 ? "has a late fee that starts" : "have late fees that start"} tomorrow`;

const itemWords = (item: EscalationItem) =>
  `${item.counterpartyName}: ${amountWords(item.amount, item.currency)}, ${STATUS[item.status]}, to decide by ${dayWords(item.decideBy)}${whyWords(item)}`;

export function decisionEscalationEmail(input: { orgName: string; items: EscalationItem[]; link: string; origin: string }): { subject: string; html: string; text: string } {
  const { orgName, link, origin } = input;
  // A payable on its late fee's eve has not passed its day: each is worded on its own, the eves first, since their fee
  // starts tomorrow; a batch with none reads as before (LF5).
  const items = [...input.items.filter((item) => item.eve), ...input.items.filter((item) => !item.eve)];
  const n = items.length;
  const eves = items.filter((item) => item.eve).length;
  const past = n - eves;
  const payments = `${n} payment${n === 1 ? "" : "s"}`;
  const feeTomorrow = eves === 1 ? "a late fee starts tomorrow" : "late fees start tomorrow";
  const subject =
    eves === 0
      ? `${payments} passed ${n === 1 ? "its" : "their"} decide-by day in ${orgName}`
      : past === 0
        ? `${feeTomorrow.charAt(0).toUpperCase()}${feeTomorrow.slice(1)} on ${payments} in ${orgName}`
        : `${payments} wait for a decision in ${orgName}; ${feeTomorrow}`;
  const opening =
    eves === 0 ? passedWords(n) : past === 0 ? feeTomorrowWords(n) : `wait for a decision: ${past} ${passedWords(past)}, and ${eves} ${feeTomorrowWords(eves)}`;
  const shown = items.slice(0, ESCALATION_MAX_ITEMS);
  const more = n - shown.length;
  const footer = `You get this because you can approve payments in ${orgName}. You can turn these emails off in Settings, under Notifications.`;
  const html = actionEmailHtml({
    title: eves === 0 ? "Payments past their decide-by day" : past === 0 ? "Before a late fee starts" : "Payments waiting for a decision",
    preheader: eves === 0 ? `${payments} in ${orgName} waited past the day to decide ${n === 1 ? "it" : "them"}.` : `${payments} in ${orgName} ${opening}.`,
    eyebrow: eves === 0 ? "Past the day to decide" : past === 0 ? "The last day without the fee" : "The day to decide",
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
