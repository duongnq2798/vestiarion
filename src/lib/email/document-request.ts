import { missingWords, type MissingDocument } from "../document-requests/rules";
import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email a vendor's billing address gets when the agent asks for a bill's missing document
 * (docs/superpowers/specs/2026-10-23-document-requests-design.md ER4): which business asks, for which of the vendor's own
 * invoices, its amount and due date, what is missing, and the one-time link, where the vendor sends it without an
 * account. It promises no payment and never asks for a password, a key or a payment. A template; nothing a model wrote.
 * A sandbox's goes to the member who set vendor requests, in place of the vendor, and says so.
 */
export function documentRequestEmail(input: {
  orgName: string;
  vendorName: string;
  /** The vendor's own invoice number, as the bill's reference; null when the bill has none. */
  reference: string | null;
  /** The amount, as "1,000.00", and its token. */
  amount: string;
  token: string;
  /** The due date and the link's last day, as "Oct 30, 2026". */
  dueOn: string;
  until: string;
  missing: readonly MissingDocument[];
  url: string;
  origin: string;
  /** A sandbox's request, sent to the member who set vendor requests in place of the vendor. */
  sandbox?: boolean;
}): { subject: string; html: string; text: string } {
  const { orgName, vendorName, reference, amount, token, dueOn, until, url, origin } = input;
  const what = missingWords(input.missing);
  const invoice = reference ? `invoice ${reference}` : "your invoice";
  const subject = `${input.sandbox ? "[Sandbox] " : ""}${orgName} needs ${what} for ${invoice}`;
  const play = input.sandbox
    ? `This is a sandbox, so Vestiarion never emails its vendors. You get this in place of ${vendorName}, so you can send the document as they would.`
    : null;
  const lead = `${orgName} has ${invoice} for ${amount} ${token}, due ${dueOn}. To check it, they need ${what}.`;
  const how = "Send it with the link below: one PDF, PNG or JPEG of up to 10 MB. You can add the purchase order number and a short note.";
  const safe = "The link needs no account, and never asks for a password, a key or a payment.";
  const note = `The link takes one document, until ${until} (UTC). For anything else about this invoice, contact ${orgName}.`;

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "A document for your invoice",
    heading: `Hi ${vendorName}, ${orgName} needs ${what}`,
    paragraphsHtml: [...(play ? [escapeHtml(play)] : []), escapeHtml(lead), escapeHtml(how), escapeHtml(safe)],
    button: { label: "Send the document", link: url },
    note,
    origin,
    loop: "document_request",
  });
  const text = [`Hi ${vendorName},`, "", ...(play ? [play, ""] : []), lead, "", how, `Send the document: ${url}`, "", safe, "", note].join("\n");
  return { subject, html, text };
}
