import type { TaskReason } from "../collection-context/model";
import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email a member gets when the collections stage asks them to act on a receivable
 * (docs/superpowers/specs/2026-10-13-collections-context-design.md C6): who it is about, what is asked, the facts it rests
 * on (at most four), and a link to the receivable. Never the customer's address, and nothing a customer or a CRM wrote
 * in its own words: the facts are Vestiarion's own sentences.
 */

const SUBJECTS: Record<TaskReason, (customer: string) => string> = {
  policy_ask_first: (customer) => `${customer}: a reminder waits for your OK`,
  hubspot_owner: (customer) => `${customer}: did sales give more time to pay?`,
  no_contact: (customer) => `${customer}: no billing contact for an invoice`,
  promise_passed: (customer) => `${customer} missed the day it promised to pay`,
  claim_unverified: (customer) => `${customer} says it paid: the payment is not found`,
  reminders_done: (customer) => `${customer}: the agent's reminders are done`,
};

const ASKS: Record<TaskReason, string> = {
  policy_ask_first: "Its rules say to ask first. Read the reminder the agent drafted, then send it, hold reminders until a day, or turn them off for this invoice.",
  hubspot_owner: "It was sold through HubSpot, and its deal has an owner there. Before the first overdue reminder, check whether sales gave the customer more time, then send the reminder or hold reminders until a day.",
  no_contact: "No reminder can go without a billing email. Add one on Counterparties, then mark this done.",
  promise_passed: "No reminder went: finance reviews a broken promise first. Let reminders go again, or hold them until a day.",
  claim_unverified:
    "No reminder went while the customer says it paid, and a week passed without the payment being found. Find it and apply it under Apply payments, or mark it not received to let reminders go again or hold them until a day.",
  reminders_done: "The agent sends no more reminders for it. Follow up with the customer yourself, then mark this done.",
};

export function collectionTaskEmail(input: {
  orgName: string;
  customerName: string;
  reason: TaskReason;
  /** The proposal's facts, in Vestiarion's words; at most four are sent. */
  facts: readonly string[];
  link: string;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { orgName, customerName, reason, link, origin } = input;
  const subject = SUBJECTS[reason](customerName);
  const lead = `The agent needs a person before it reminds ${customerName} about an invoice to ${orgName}.`;
  const facts = input.facts.slice(0, 4);
  const ask = ASKS[reason];

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "Collections",
    heading: subject,
    paragraphsHtml: [escapeHtml(lead), ...facts.map((fact) => `· ${escapeHtml(fact)}`), escapeHtml(ask)],
    button: { label: "Open the invoice", link },
    note: `Sent to the people of ${orgName} asked to act on collections who get email from Vestiarion. To stop it, turn off "Email me when payments need a decision" in Settings.`,
    origin,
  });

  const text = [lead, "", ...facts.map((fact) => `- ${fact}`), "", ask, link].join("\n");
  return { subject, html, text };
}
