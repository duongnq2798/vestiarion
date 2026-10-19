import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email a workspace's owners and admins, who add bills, get when a payee sends its invoice through its payee link
 * (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md P7): who sent which invoice, for how much and when it
 * is due, and that it waits on Bills until one of them adds it or discards it. A member's email: no counterparty link.
 */
export function payeeInvoiceEmail(input: {
  orgName: string;
  payeeName: string;
  invoiceNumber: string;
  amount: string;
  dueDate: string;
  link: string;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { orgName, payeeName, invoiceNumber, amount, dueDate, link, origin } = input;
  const subject = `${payeeName} sent an invoice through their payee link`;
  const lead = `${payeeName} sent invoice ${invoiceNumber} for ${amount} USDC, due ${dueDate}, through the payee link ${orgName} sent them.`;
  const hold =
    "It waits under Waiting for review on Bills until someone adds it as a bill or discards it. Nothing is paid because it arrived: once added, the agent decides it like any other bill.";

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "Invoice to review",
    heading: subject,
    paragraphsHtml: [escapeHtml(lead), escapeHtml(hold)],
    button: { label: "Review it on Bills", link },
    note: `Sent to the owners and admins of ${orgName}, who add bills.`,
    origin,
  });

  const text = [lead, "", hold, link].join("\n");
  return { subject, html, text };
}
