import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email a customer gets when the agent offers a discount for paying early (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md
 * C7): who offers, for which invoice, what they pay by when instead of the full amount on the due date, and the offer's
 * one-time link, where they accept or decline. A template; nothing a model wrote.
 */
export function customerDiscountEmail(input: {
  orgName: string;
  customerName: string;
  /** The invoice's reference (its memo); null when nothing says. */
  reference: string | null;
  /** The full amount and what the customer pays at the discount, as "1,000.00". */
  amount: string;
  discounted: string;
  token: string;
  pct: number;
  /** The due date and the last day to pay at the discount, as "Oct 30, 2026". */
  dueOn: string;
  payBy: string;
  url: string;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { orgName, customerName, reference, amount, discounted, token, pct, dueOn, payBy, url, origin } = input;
  const invoice = reference ? `invoice ${reference}` : "your invoice";
  const subject = `${orgName} offers ${pct.toFixed(2)}% off ${invoice} for paying by ${payBy}`;
  const lead = `${orgName} offers you ${pct.toFixed(2)}% off ${invoice}: pay ${discounted} ${token} by ${payBy} instead of ${amount} ${token} on ${dueOn}.`;
  const terms = `Accept it and the invoice's amount becomes ${discounted} ${token} until the end of ${payBy} (UTC), paid the way you would pay it anyway, through its pay link. The link works once.`;
  const nothing = `If you would rather keep the due date, decline it or do nothing: the invoice stays ${amount} ${token}, due on ${dueOn}.`;
  const note = `You get this because ${orgName} bills you through Vestiarion and asked its agent to offer early-payment discounts. For anything about this invoice, contact ${orgName}.`;

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "Early payment",
    heading: `Hi ${customerName}, pay less by paying early`,
    paragraphsHtml: [escapeHtml(lead), escapeHtml(terms), escapeHtml(nothing)],
    button: { label: "See the offer", link: url },
    note,
    origin,
  });
  const text = [`Hi ${customerName},`, "", lead, terms, nothing, "", `See the offer: ${url}`, "", note].join("\n");
  return { subject, html, text };
}
