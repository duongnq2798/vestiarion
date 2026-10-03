import type { ReminderTone } from "../collections";
import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email a client gets when the agent reminds them of a receivable (collections R6): who asks, how much and its
 * token, what for, when it was due, how late it is, and the pay link. A template by tone; nothing a model wrote.
 */
export function receivableReminderEmail(input: {
  orgName: string;
  clientName: string;
  amount: string;
  token: string;
  /** What it is for: the invoice's memo and purchase order; null when nothing says. */
  what: string | null;
  /** The due date, as "Oct 6, 2026". */
  dueOn: string;
  /** Days from the due date to today: negative before it, 0 on it. */
  daysFromDue: number;
  tone: ReminderTone;
  payUrl: string;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { orgName, clientName, amount, token, what, dueOn, daysFromDue, tone, payUrl, origin } = input;
  const days = Math.abs(daysFromDue);
  const dayWords = `${days} ${days === 1 ? "day" : "days"}`;
  const money = `${amount} ${token}`;
  const forWhat = what ? ` for ${what}` : "";

  const subject =
    tone === "final"
      ? `Final reminder: ${money} to ${orgName}, due ${dueOn}`
      : tone === "firm"
        ? `Reminder: ${money} to ${orgName} was due ${dueOn}`
        : daysFromDue < 0
          ? `${orgName}: ${money} due ${dueOn}`
          : daysFromDue === 0
            ? `${orgName}: ${money} due today`
            : `${orgName}: ${money} was due ${dueOn}`;

  const lead =
    tone === "friendly"
      ? daysFromDue < 0
        ? `${orgName} asked you to pay ${money}${forWhat}, due ${dueOn}, in ${dayWords}.`
        : daysFromDue === 0
          ? `${orgName} asked you to pay ${money}${forWhat}, due today, ${dueOn}.`
          : `${orgName} asked you to pay ${money}${forWhat}, which was due ${dueOn}, ${dayWords} ago.`
      : `Your payment of ${money} to ${orgName}${forWhat} was due ${dueOn}, ${dayWords} ago, and has not arrived.`;
  const how = "Pay it on Arc testnet from any wallet: the page shows the amount and the address to send it to.";
  const last = tone === "final" ? `This is the last reminder Vestiarion sends for it. After this, ${orgName} follows up with you directly.` : null;
  const note = `Already paid? It can take a minute to show, and you can ignore this email. You get it because ${orgName} sends its invoices through Vestiarion and asked its agent to remind you. For anything about this invoice, contact ${orgName}.`;

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: tone === "final" ? "Final reminder" : tone === "firm" ? "Payment overdue" : "Payment reminder",
    heading: tone === "final" ? `Hi ${clientName}, a final reminder` : tone === "firm" ? `Hi ${clientName}, this payment is overdue` : `Hi ${clientName}, a reminder from ${orgName}`,
    paragraphsHtml: [escapeHtml(lead), escapeHtml(how), ...(last ? [escapeHtml(last)] : [])],
    button: { label: "Pay on Arc testnet", link: payUrl },
    note,
    origin,
  });

  const text = [`Hi ${clientName},`, "", lead, how, ...(last ? [last] : []), "", `Pay on Arc testnet: ${payUrl}`, "", note].join("\n");
  return { subject, html, text };
}
