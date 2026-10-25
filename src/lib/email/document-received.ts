import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email a workspace's owners and admins get when a vendor sends a document through its request's link
 * (docs/superpowers/specs/2026-10-23-document-requests-design.md ER5, ER6): who sent it, for which bill, and whether they
 * typed a purchase order number. Never the number itself, nor anything else the vendor typed: those are words from
 * whoever holds the link, and this email comes from Vestiarion's own address, so they stay on the bill's card, behind
 * sign-in. Nothing changed on the bill: a person adds the details, and the agent decides it again. While vendor
 * requests are in shadow or on, it says instead what the cycle's check does
 * (docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md DK1). A member's email: no counterparty link.
 */
export function documentReceivedEmail(input: {
  orgName: string;
  vendorName: string;
  /** The bill's reference, the vendor's invoice number; null when it has none. */
  reference: string | null;
  /** Whether the vendor typed a purchase order number with the document. */
  typedPo: boolean;
  /** How the cycle checks it: in shadow or on; null (or absent) while off, or before migration 0144. */
  checks?: "shadow" | "on" | null;
  link: string;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { orgName, vendorName, reference, typedPo, link, origin } = input;
  const bill = reference ? `invoice ${reference}` : "their invoice";
  const subject = `${vendorName} sent a document for ${bill}`;
  const lead = `${vendorName} sent a document for ${bill} through the link the agent emailed them${typedPo ? ", with a purchase order number" : ""}.`;
  const next =
    input.checks === "on"
      ? "Open it on the bill's card in Approvals. Vestiarion checks it against the bill within a minute: when the vendor, amount and purchase order match, it adds the purchase order, and a person approves the payment."
      : input.checks === "shadow"
        ? "Open it on the bill's card in Approvals. Vestiarion checks it against the bill within a minute and says what it found; in shadow, the bill does not change."
        : "Open it on the bill's card in Approvals. Nothing changed on the bill: add the details it shows, and the agent decides it again.";

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
