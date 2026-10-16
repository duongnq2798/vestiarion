import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email a supplier gets when the agent offers early payment (docs/superpowers/specs/2026-10-16-agent-early-payment-offers-design.md
 * AO4): who offers, for which invoice, what they receive today instead of on the due date, until when, and the offer's
 * one-time link, where they accept or decline. A template; nothing a model wrote.
 */
export function earlyPaymentOfferEmail(input: {
  orgName: string;
  supplierName: string;
  /** The invoice's reference (its memo); null when nothing says. */
  reference: string | null;
  /** What the invoice is for and what the supplier would receive, as "1,000.00". */
  amount: string;
  offered: string;
  token: string;
  pct: number;
  /** The due date and the offer's last day, as "Oct 30, 2026". */
  dueOn: string;
  until: string;
  url: string;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { orgName, supplierName, reference, amount, offered, token, pct, dueOn, until, url, origin } = input;
  const invoice = reference ? `invoice ${reference}` : "your invoice";
  const subject = `${orgName} offers to pay ${invoice} today`;
  const lead = `${orgName} offers to pay ${invoice} today: ${offered} ${token} instead of ${amount} ${token} on ${dueOn}.`;
  const terms = `That is ${pct.toFixed(2)}% less, paid today instead of waiting for the due date. It goes where ${orgName} already pays you. The offer stands until ${until}, and the link works once.`;
  const nothing = `If you would rather wait, decline it or do nothing: your invoice is paid as planned, on its due date.`;
  const note = `You get this because ${orgName} pays its bills through Vestiarion and asked its agent to offer early payment. For anything about this invoice, contact ${orgName}.`;

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "Early payment",
    heading: `Hi ${supplierName}, get paid today`,
    paragraphsHtml: [escapeHtml(lead), escapeHtml(terms), escapeHtml(nothing)],
    button: { label: "See the offer", link: url },
    note,
    origin,
  });
  const text = [`Hi ${supplierName},`, "", lead, terms, nothing, "", `See the offer: ${url}`, "", note].join("\n");
  return { subject, html, text };
}
