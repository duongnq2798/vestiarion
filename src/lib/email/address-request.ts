import { networkProfile, type Network } from "../network";
import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email a payee gets when a business asks it for the address to pay it at (docs/superpowers/specs/
 * 2026-10-18-ask-every-payee-design.md A4): which business asks, the network it pays on, and the one-time link where the
 * payee adds its address, which is paid only once someone at the business confirms it. A business in shadow mode still
 * pays its suppliers its own way, so the email says it is getting ready to pay in USDC and names no network. A workspace
 * that simulates its payments sends none of these.
 */
export function addressRequestEmail(input: {
  orgName: string;
  payeeName: string;
  link: string;
  expiresAt: Date;
  origin: string;
  /** The asking workspace's network, named in the email (mainnet copy C1). */
  network: Network;
  /** The asking workspace is in shadow mode: it still pays its suppliers its own way. */
  shadow?: boolean;
}): { subject: string; html: string; text: string } {
  const { orgName, payeeName, link, expiresAt, origin } = input;
  const { label } = networkProfile(input.network);
  const subject = `${orgName} asks where to pay you`;
  const lead = input.shadow
    ? `${orgName} is getting ready to pay you in USDC and asks for the address to send it to.`
    : `${orgName} pays you in USDC on ${label} and asks for the address to send it to.`;
  const how = "Add the address you want to be paid at. Any EVM wallet address works, such as one from MetaMask.";
  const safe = `Nothing is paid to it until someone at ${orgName} confirms it.`;
  const expiry = `The link takes your address once, before ${expiresAt.toISOString().slice(0, 10)} (UTC), and needs no account.`;

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "Your payment address",
    heading: `Hi ${payeeName}, where should ${orgName} pay you?`,
    paragraphsHtml: [
      input.shadow
        ? `<strong style="color:#18211c;">${escapeHtml(orgName)}</strong> is getting ready to pay you in USDC and asks for the address to send it to.`
        : `<strong style="color:#18211c;">${escapeHtml(orgName)}</strong> pays you in USDC on ${escapeHtml(label)} and asks for the address to send it to.`,
      escapeHtml(how),
      escapeHtml(safe),
    ],
    button: { label: "Add my address", link },
    note: expiry,
    origin,
  });

  const text = [`Hi ${payeeName},`, "", lead, "", how, link, "", safe, "", expiry].join("\n");
  return { subject, html, text };
}
