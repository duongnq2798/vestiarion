import { networkProfile, type Network } from "../network";
import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email a freelancer gets when a business sets up a payment to them
 * (docs/superpowers/specs/2026-10-01-pay-a-freelancer-design.md §2): who is
 * paying, how much and for what, and the one-time link where they add the
 * address to be paid at.
 */
export function payeeLinkEmail(input: {
  orgName: string;
  payeeName: string;
  work: string;
  amount: string;
  link: string;
  expiresAt: Date;
  origin: string;
  /** The paying workspace's network, named in the email (mainnet copy C1). */
  network: Network;
}): { subject: string; html: string; text: string } {
  const { orgName, payeeName, work, amount, link, expiresAt, origin } = input;
  const { label } = networkProfile(input.network);
  const expiry = `The link takes your address once, before ${expiresAt.toISOString().slice(0, 10)} (UTC). After that, the same link shows your payment's status, step by step, for 30 days.`;
  const subject = `${orgName} wants to pay you ${amount} USDC`;
  const lead = `${orgName} wants to pay you ${amount} USDC on ${label} for: ${work}.`;
  const how = "Add the address you want to be paid at. Any EVM wallet address works, such as one from MetaMask.";

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "Payment for your work",
    heading: `Hi ${payeeName}, you have a payment waiting`,
    paragraphsHtml: [
      `<strong style="color:#18211c;">${escapeHtml(orgName)}</strong> wants to pay you <strong style="color:#18211c;">${escapeHtml(amount)} USDC</strong> on ${escapeHtml(label)} for: ${escapeHtml(work)}.`,
      escapeHtml(how),
    ],
    button: { label: "Add my address", link },
    note: expiry,
    origin,
  });

  const text = [`Hi ${payeeName},`, "", lead, "", how, link, "", expiry].join("\n");
  return { subject, html, text };
}
