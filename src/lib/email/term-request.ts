import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email a supplier gets when the agent asks for more time (docs/superpowers/specs/2026-10-17-term-requests-design.md
 * X4, X6): who asks, for which invoice, the new date and the full amount, until when, and the request's one-time link,
 * where they agree or decline. A template; nothing a model wrote.
 */
export function termRequestEmail(input: {
  orgName: string;
  supplierName: string;
  /** The invoice's reference (its memo); null when nothing says. */
  reference: string | null;
  /** The amount, as "1,000.00", and its token. */
  amount: string;
  token: string;
  days: number;
  /** The due date, the new one, and the request's last day, as "Oct 30, 2026". */
  dueOn: string;
  newDueOn: string;
  until: string;
  url: string;
  origin: string;
  /** A sandbox's request, sent to the member who turned the requests on in place of the sample supplier. */
  sandbox?: boolean;
}): { subject: string; html: string; text: string } {
  const { orgName, supplierName, reference, amount, token, days, dueOn, newDueOn, until, url, origin } = input;
  const invoice = reference ? `invoice ${reference}` : "your invoice";
  const subject = `${input.sandbox ? "[Sandbox] " : ""}${orgName} asks for ${days} more days on ${invoice}`;
  const lead = `${orgName} asks to pay ${invoice} on ${newDueOn} instead of ${dueOn}: ${days} more days, for the full ${amount} ${token}.`;
  const terms = `Nothing else changes: the same amount, to where ${orgName} already pays you. The request stands until ${until}, and the link works once.`;
  const nothing = `If you decline, or do nothing, the invoice stays due on ${dueOn}.`;
  const play = input.sandbox
    ? `This is a sandbox. You get this in place of ${supplierName}, a sample supplier, so you can answer as the supplier would. Its payments are simulated.`
    : null;
  const note = `You get this because ${orgName} pays its bills through Vestiarion and asked its agent to ask for more time when cash is short. For anything about this invoice, contact ${orgName}.`;

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "Payment terms",
    heading: `Hi ${supplierName}, a request for more time`,
    paragraphsHtml: [...(play ? [escapeHtml(play)] : []), escapeHtml(lead), escapeHtml(terms), escapeHtml(nothing)],
    button: { label: "See the request", link: url },
    note,
    origin,
    loop: "term_request",
  });
  const text = [`Hi ${supplierName},`, "", ...(play ? [play, ""] : []), lead, terms, nothing, "", `See the request: ${url}`, "", note].join("\n");
  return { subject, html, text };
}

/**
 * The email a supplier gets when the agent answers its counter (docs/superpowers/specs/2026-10-17-term-requests-follow-up-design.md
 * F7): accepted, the invoice's new due date; declined, that it stays due on its date. A template; nothing a model wrote.
 */
export function termCounterAnswerEmail(input: {
  orgName: string;
  supplierName: string;
  reference: string | null;
  accepted: boolean;
  counterDays: number;
  /** The amount, as "1,000.00", and its token. */
  amount: string;
  token: string;
  /** The due date and, accepted, the new one, as "Oct 30, 2026". */
  dueOn: string;
  newDueOn: string | null;
  origin: string;
  sandbox?: boolean;
}): { subject: string; html: string; text: string } {
  const { orgName, supplierName, reference, accepted, counterDays, amount, token, dueOn, newDueOn, origin } = input;
  const invoice = reference ? `invoice ${reference}` : "your invoice";
  const dayWord = counterDays === 1 ? "1 more day" : `${counterDays} more days`;
  const subject = `${input.sandbox ? "[Sandbox] " : ""}${accepted ? `${orgName} accepted your ${dayWord} on ${invoice}` : `${orgName} keeps the original due date for ${invoice}`}`;
  const lead = accepted
    ? `${orgName} accepted your ${dayWord}: ${invoice} now falls due on ${newDueOn}, for the full ${amount} ${token}.`
    : `${orgName} cannot take ${dayWord}, so ${invoice} stays due on ${dueOn}, for the full ${amount} ${token}.`;
  const after = accepted ? "It is paid to where it already pays you. You get a payment notice when it is confirmed." : "Nothing else changes, and there is nothing for you to do.";
  const play = input.sandbox ? `This is a sandbox. You get this in place of ${supplierName}, a sample supplier. Its payments are simulated.` : null;
  const note = `You get this because you answered ${orgName}'s request for more time through Vestiarion. For anything about this invoice, contact ${orgName}.`;
  const guide = `${origin}/docs/guides/more-time`;
  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "Payment terms",
    heading: accepted ? `Hi ${supplierName}, the new date is agreed` : `Hi ${supplierName}, the due date stands`,
    paragraphsHtml: [...(play ? [escapeHtml(play)] : []), escapeHtml(lead), escapeHtml(after)],
    button: { label: "How requests for more time work", link: guide },
    note,
    origin,
    loop: "term_request",
  });
  const text = [`Hi ${supplierName},`, "", ...(play ? [play, ""] : []), lead, after, "", `How requests for more time work: ${guide}`, "", note].join("\n");
  return { subject, html, text };
}

/**
 * The email a supplier gets when the agent withdraws its request for more time because it is no longer needed
 * (docs/superpowers/specs/2026-10-17-term-requests-follow-up-design.md F1): the bill is being paid on time, or stays due on
 * its date. The earlier link no longer works. A template; nothing a model wrote.
 */
export function termRequestWithdrawnEmail(input: {
  orgName: string;
  supplierName: string;
  reference: string | null;
  /** The amount, as "1,000.00", and its token. */
  amount: string;
  token: string;
  days: number;
  /** The due date, as "Oct 30, 2026". */
  dueOn: string;
  /** The bill is being paid now, not only kept to its date. */
  paying: boolean;
  origin: string;
  sandbox?: boolean;
}): { subject: string; html: string; text: string } {
  const { orgName, supplierName, reference, amount, token, days, dueOn, paying, origin } = input;
  const invoice = reference ? `invoice ${reference}` : "your invoice";
  const subject = `${input.sandbox ? "[Sandbox] " : ""}${orgName} no longer needs more time on ${invoice}`;
  const lead = paying
    ? `${orgName} is paying ${invoice}, ${amount} ${token}, on time, so it no longer needs the ${days} more days it asked for.`
    : `${orgName} no longer needs the ${days} more days it asked for on ${invoice}: it stays due on ${dueOn}, as before.`;
  const after = `The earlier link no longer works, and there is nothing for you to do.${paying ? " You get a payment notice when the payment is confirmed." : ""}`;
  const play = input.sandbox ? `This is a sandbox. You get this in place of ${supplierName}, a sample supplier. Its payments are simulated.` : null;
  const note = `You get this because ${orgName} asked you for more time through Vestiarion. For anything about this invoice, contact ${orgName}.`;
  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "Payment terms",
    heading: `Hi ${supplierName}, no more time needed`,
    paragraphsHtml: [...(play ? [escapeHtml(play)] : []), escapeHtml(lead), escapeHtml(after)],
    button: { label: "How requests for more time work", link: `${origin}/docs/guides/more-time` },
    note,
    origin,
    loop: "term_request",
  });
  const text = [`Hi ${supplierName},`, "", ...(play ? [play, ""] : []), lead, after, "", `How requests for more time work: ${origin}/docs/guides/more-time`, "", note].join("\n");
  return { subject, html, text };
}
