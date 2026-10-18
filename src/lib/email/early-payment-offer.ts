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
  /** A sandbox's offer, sent to the member who turned the offers on in place of the sample supplier (sandbox offers S1). */
  sandbox?: boolean;
}): { subject: string; html: string; text: string } {
  const { orgName, supplierName, reference, amount, offered, token, pct, dueOn, until, url, origin } = input;
  const invoice = reference ? `invoice ${reference}` : "your invoice";
  const subject = `${input.sandbox ? "[Sandbox] " : ""}${orgName} offers to pay ${invoice} today`;
  const lead = `${orgName} offers to pay ${invoice} today: ${offered} ${token} instead of ${amount} ${token} on ${dueOn}.`;
  const terms = `That is ${pct.toFixed(2)}% less, paid today instead of waiting for the due date. It goes where ${orgName} already pays you. The offer stands until ${until}, and the link works once.`;
  const nothing = `If you would rather wait, decline it or do nothing: your invoice is paid as planned, on its due date.`;
  const play = input.sandbox ? sandboxLine(supplierName) : null;
  const note = `You get this because ${orgName} pays its bills through Vestiarion and asked its agent to offer early payment. For anything about this invoice, contact ${orgName}.`;

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "Early payment",
    heading: `Hi ${supplierName}, get paid today`,
    paragraphsHtml: [...(play ? [escapeHtml(play)] : []), escapeHtml(lead), escapeHtml(terms), escapeHtml(nothing)],
    button: { label: "See the offer", link: url },
    note,
    origin,
    loop: "early_offer",
  });
  const text = [`Hi ${supplierName},`, "", ...(play ? [play, ""] : []), lead, terms, nothing, "", `See the offer: ${url}`, "", note].join("\n");
  return { subject, html, text };
}

/** What a sandbox's email says first: who it is really for, and that nothing real is paid (sandbox offers S1). */
function sandboxLine(supplierName: string): string {
  return `This is a sandbox. You get this in place of ${supplierName}, a sample supplier, so you can answer as the supplier would. Its payments are simulated.`;
}

/**
 * The email a supplier gets when the agent answers its counter (docs/superpowers/specs/2026-10-17-offer-counters-design.md
 * N6): accepted, what it is paid today; declined, that the invoice keeps its due date. A template; nothing a model wrote.
 */
export function counterAnswerEmail(input: {
  orgName: string;
  supplierName: string;
  reference: string | null;
  accepted: boolean;
  /** The discount the supplier proposed, and, accepted, what it receives today, as "0.4988". */
  counterPct: number;
  offered: string | null;
  amount: string;
  token: string;
  dueOn: string;
  origin: string;
  /** A sandbox's answer, sent to the member who answered as the supplier (sandbox offers S1). */
  sandbox?: boolean;
}): { subject: string; html: string; text: string } {
  const { orgName, supplierName, reference, accepted, counterPct, offered, amount, token, dueOn, origin } = input;
  const invoice = reference ? `invoice ${reference}` : "your invoice";
  const subject = `${input.sandbox ? "[Sandbox] " : ""}${accepted ? `${orgName} accepted your ${counterPct.toFixed(2)}% for ${invoice}` : `${orgName} keeps the original terms for ${invoice}`}`;
  const lead = accepted
    ? `${orgName} accepted your ${counterPct.toFixed(2)}%: it pays you ${offered} ${token} today, instead of ${amount} ${token} on ${dueOn}, once its usual checks pass.`
    : `${orgName} keeps the original terms: your invoice is paid as planned, ${amount} ${token} on ${dueOn}.`;
  const after = accepted ? "It goes where it already pays you. You get a payment notice when it is confirmed." : "Nothing else changes, and there is nothing for you to do.";
  const guide = `${origin}/docs/guides/early-payment-offers`;
  const note = `You get this because you answered ${orgName}'s early-payment offer through Vestiarion. For anything about this invoice, contact ${orgName}.`;
  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "Early payment",
    heading: accepted ? `Hi ${supplierName}, you are paid today` : `Hi ${supplierName}, the due date stands`,
    paragraphsHtml: [...(input.sandbox ? [escapeHtml(sandboxLine(supplierName))] : []), escapeHtml(lead), escapeHtml(after)],
    button: { label: "How early payment works", link: guide },
    note,
    origin,
    loop: "early_offer",
  });
  const text = [`Hi ${supplierName},`, "", ...(input.sandbox ? [sandboxLine(supplierName), ""] : []), lead, after, "", `How early payment works: ${guide}`, "", note].join("\n");
  return { subject, html, text };
}
