import type { RequestKind } from "../customer-portal/model";
import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email the members who answer customers get when a customer writes on its statement link
 * (docs/superpowers/specs/2026-10-13-customer-portal-design.md P8): who wrote, what kind of request, a short preview of
 * its words, and a link to From customers. Nothing else the customer wrote (a reference, an amount, a day) is in it, and
 * the preview leaves out links, so the email never carries a customer's address for a member to follow.
 */

/** The most characters of the customer's words an email shows. */
export const PREVIEW_MAX = 140;

const LINK = /\b(?:https?:\/\/|www\.)\S+/gi;

/** The customer's words as one line of at most `PREVIEW_MAX` characters, links left out; null when there are none. */
export function customerPreview(words: string | null): string | null {
  const line = (words ?? "").replace(LINK, "[link]").replace(/\s+/g, " ").trim();
  if (!line) return null;
  const characters = [...line];
  return characters.length <= PREVIEW_MAX ? line : `${characters.slice(0, PREVIEW_MAX - 1).join("").trimEnd()}…`;
}

const SUBJECTS: Record<RequestKind, (customer: string) => string> = {
  paid: (customer) => `${customer} says it paid an invoice`,
  promise: (customer) => `${customer} promised to pay an invoice`,
  dispute: (customer) => `${customer} disputed an invoice`,
  pay_link: (customer) => `${customer} asked for a pay link`,
};

const WHAT_IT_MEANS: Record<RequestKind, string> = {
  paid: "It is the customer's word, not a payment: the invoice stays open until the money arrives and is applied. The agent's reminders about it wait until you find the payment or mark it not received.",
  promise: "The agent's reminders about the invoice wait through the promised day.",
  dispute: "The agent's reminders about the invoice wait until you resolve the dispute.",
  pay_link: "Make the invoice's pay link, and it shows on their statement at once.",
};

export function customerWroteEmail(input: {
  orgName: string;
  customerName: string;
  kind: RequestKind;
  /** Words added under a request already open, rather than a new request. */
  more: boolean;
  /** `customerPreview` of the customer's words, or null. */
  preview: string | null;
  link: string;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { orgName, customerName, kind, more, preview, link, origin } = input;
  const subject = more ? `${customerName} wrote more on its statement` : SUBJECTS[kind](customerName);
  const lead = `${customerName} wrote to ${orgName} on its statement link.`;
  const quoted = preview ? `It wrote: “${preview}”` : null;
  const meaning = WHAT_IT_MEANS[kind];
  const next = "Read it and answer under From customers, on the Receivables tab.";

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "From a customer",
    heading: subject,
    paragraphsHtml: [escapeHtml(lead), ...(quoted ? [escapeHtml(quoted)] : []), escapeHtml(meaning), escapeHtml(next)],
    button: { label: "Open From customers", link },
    note: `Sent to the owners and admins of ${orgName} who get email from Vestiarion. To stop it, turn off "Email me when payments need a decision" in Settings.`,
    origin,
  });

  const text = [lead, ...(quoted ? [quoted] : []), "", meaning, next, link].join("\n");
  return { subject, html, text };
}
