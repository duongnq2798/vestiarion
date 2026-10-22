import { changedAtWords, shortAddress, viaWords, type AddressChangeVia } from "../address-change-check-words";
import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * "Did you change where {business} pays you?" (docs/superpowers/specs/2026-10-22-address-change-check-design.md AC2): to
 * the payee's contact on file, when its payout address changed to a new one. It shows both addresses, when
 * and how the address changed, and one link to answer, which works once and needs no account. It never asks for a
 * password, a key or a payment, and says so. A security message, so its footer carries no link back to Vestiarion.
 */
export function addressChangeCheckEmail(input: {
  orgName: string;
  payeeName: string;
  from: string;
  to: string;
  via: AddressChangeVia;
  githubLogin: string | null;
  changedAt: string;
  link: string;
  expiresAt: Date;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { orgName, payeeName, from, to, link, origin } = input;
  const subject = `Did you change where ${orgName} pays you?`;
  const how = viaWords(input.via, orgName, input.githubLogin);
  const when = changedAtWords(input.changedAt);
  const lead = `The address ${orgName} pays you at was changed ${how}, on ${when}.`;
  const ask = `If you made this change, tell us so. If you did not, tell us at once: payments to the new address stop until someone at ${orgName} checks with you.`;
  const safe = "This link never asks for a password, a key or a payment.";
  const expiry = `The link takes one answer, before ${input.expiresAt.toISOString().slice(0, 10)} (UTC), and needs no account.`;

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "Your payment address",
    heading: `Hi ${payeeName}, did you change your payment address?`,
    paragraphsHtml: [
      escapeHtml(lead),
      `Before: <span style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;color:#18211c;">${escapeHtml(shortAddress(from))}</span><br>Now: <span style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;color:#18211c;word-break:break-all;">${escapeHtml(to)}</span>`,
      escapeHtml(ask),
      escapeHtml(safe),
    ],
    button: { label: "Review this change", link },
    note: expiry,
    origin,
  });

  const text = [`Hi ${payeeName},`, "", lead, "", `Before: ${shortAddress(from)}`, `Now: ${to}`, "", ask, link, "", safe, "", expiry].join("\n");
  return { subject, html, text };
}
