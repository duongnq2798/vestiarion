import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email a payee gets once a payment to them is confirmed on Arc testnet (payment notices R2): who paid, how
 * much and its token, what for, to which address and when, with the transaction to see it on chain.
 */
export function paymentNoticeEmail(input: {
  orgName: string;
  payeeName: string;
  amount: string;
  token: string;
  /** What it pays for: the invoice's memo and purchase order, or the milestone's title; null when nothing says. */
  what: string | null;
  address: string;
  /** When the transfer was confirmed, as "Oct 3, 2026, 02:48 UTC". */
  paidAt: string;
  txUrl: string;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { orgName, payeeName, amount, token, what, address, paidAt, txUrl, origin } = input;
  const subject = `${orgName} paid you ${amount} ${token}`;
  const lead = `${orgName} paid you ${amount} ${token} on Arc testnet${what ? ` for ${what}` : ""}.`;
  const sent = `Sent to ${address} on ${paidAt}.`;
  const note = `You get this email because ${orgName} pays you through Vestiarion and gave this address for payment notices. For anything about this payment, contact ${orgName}.`;

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "Payment sent",
    heading: `Hi ${payeeName}, you have been paid`,
    paragraphsHtml: [
      `<strong style="color:#18211c;">${escapeHtml(orgName)}</strong> paid you <strong style="color:#18211c;">${escapeHtml(amount)} ${escapeHtml(token)}</strong> on Arc testnet${what ? ` for ${escapeHtml(what)}` : ""}.`,
      `Sent to <span style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:13px;">${escapeHtml(address)}</span> on ${escapeHtml(paidAt)}.`,
    ],
    button: { label: "View the transaction", link: txUrl },
    note,
    origin,
  });

  const text = [`Hi ${payeeName},`, "", lead, sent, "", `View the transaction: ${txUrl}`, "", note].join("\n");
  return { subject, html, text };
}
