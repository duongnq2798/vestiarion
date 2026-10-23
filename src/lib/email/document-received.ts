import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email a workspace's owners and admins get when a vendor sends a document through its request's link
 * (docs/superpowers/specs/2026-10-23-document-requests-design.md ER5, ER6): who sent it, for which bill, and the purchase
 * order number they typed, if any. Nothing changed on the bill: a person adds the details, and the agent decides it again.
 * A member's email: no counterparty link.
 */
export function documentReceivedEmail(input: {
  orgName: string;
  vendorName: string;
  /** The bill's reference, the vendor's invoice number; null when it has none. */
  reference: string | null;
  poReference: string | null;
  link: string;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { orgName, vendorName, reference, poReference, link, origin } = input;
  const bill = reference ? `invoice ${reference}` : "their invoice";
  const subject = `${vendorName} sent a document for ${bill}`;
  const lead = `${vendorName} sent a document for ${bill} through the link the agent emailed them${poReference ? `, with purchase order ${poReference}` : ""}.`;
  const next = "Open it on the bill's card in Approvals. Nothing changed on the bill: add the details it shows, and the agent decides it again.";

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "A document arrived",
    heading: subject,
    paragraphsHtml: [escapeHtml(lead), escapeHtml(next)],
    button: { label: "Open it in Approvals", link },
    note: `Sent to the owners and admins of ${orgName}, who add details to bills.`,
    origin,
  });
  const text = [lead, "", next, link].join("\n");
  return { subject, html, text };
}
