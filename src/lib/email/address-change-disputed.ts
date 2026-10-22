import { shortAddress } from "../address-change-check-words";
import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * To a workspace's owners and admins when a payee's contact said they did not make an address change
 * (docs/superpowers/specs/2026-10-22-address-change-check-design.md AC3): the payee, the address in question, and whether
 * the payee is frozen, with a link to Counterparties, where an owner or admin unfreezes it once they have checked.
 */
export function addressChangeDisputedEmail(input: {
  orgName: string;
  payeeName: string;
  to: string;
  frozen: boolean;
  link: string;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { orgName, payeeName, to, link, origin } = input;
  const subject = `${payeeName} says they did not change their payment address`;
  const lead = `${payeeName}'s contact on file said they did not change the address ${orgName} pays them at to ${shortAddress(to)}.`;
  const state = input.frozen
    ? `${payeeName} is frozen: the address is no longer confirmed, and no one can confirm it until an owner or admin unfreezes ${payeeName} on Counterparties.`
    : `That address is no longer the one on file, so nothing was frozen. Check how it was changed.`;
  const next = `Check with ${payeeName} by a contact you had before. Change the address back if it is not theirs, then unfreeze them: they stay frozen until an owner or admin does.`;

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "Address change disputed",
    heading: subject,
    paragraphsHtml: [escapeHtml(lead), escapeHtml(state), escapeHtml(next)],
    button: { label: "Open Counterparties", link },
    note: "Every answer and every change is in the workspace's ledger.",
    origin,
  });

  const text = [lead, "", state, "", next, link].join("\n");
  return { subject, html, text };
}
