import { networkProfile, type Network } from "../network";
import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email a workspace's deciding members get about a payment that has not confirmed (docs/superpowers/specs/
 * 2026-10-06-stuck-transfer-alert-design.md D6, D7): which payment, how long ago it was sent and on which network, what
 * Circle says, and that Vestiarion sends nothing again while it may still settle. Speeding up or cancelling a transfer
 * stays out of scope, as the failed-transfer retry design ruled.
 */
export function paymentStuckEmail(input: {
  orgName: string;
  payeeName: string;
  /** As "12.50". */
  amount: string;
  currency: string;
  minutes: number;
  network: Network;
  /** Whether Circle was asked this time; false when no provider could be had, or Circle did not answer. */
  circleAsked: boolean;
  /** Whether Circle answered the send itself; false for a send it never answered. */
  sendAnswered: boolean;
  providerState: string | null;
  txUrl: string | null;
  /** Where in the workspace the payment is: its invoice's steps, or Contractors. */
  link: string;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { label } = networkProfile(input.network);
  const money = `${input.amount} ${input.currency}`;
  const subject = `A payment of ${money} to ${input.payeeName} has not confirmed`;
  const lead = `The payment of ${money} to ${input.payeeName}, sent ${input.minutes} minutes ago on ${label}, has not confirmed.`;
  const circle = !input.sendAnswered
    ? "Circle never answered when it was sent, so it may not have taken the transfer."
    : !input.circleAsked
      ? "Vestiarion could not ask Circle about it just now."
      : input.providerState === "STUCK"
        ? "Circle shows it stuck: check it in Circle's console, or contact Circle support."
        : `Circle shows it as ${input.providerState ?? "pending"}.`;
  const after = "Vestiarion sends nothing again while it may still settle, and checks it again at the next cycle.";
  const note = `You get this email because you can approve payments in ${input.orgName} and have email notices on.`;

  const html = actionEmailHtml({
    title: subject,
    preheader: lead,
    eyebrow: "Payment not confirmed",
    heading: "A payment has not confirmed",
    paragraphsHtml: [
      escapeHtml(lead),
      escapeHtml(circle),
      escapeHtml(after),
      ...(input.txUrl ? [`<a href="${escapeHtml(input.txUrl)}" style="color:#18211c;">View the transaction</a>`] : []),
    ],
    button: { label: "See it in Vestiarion", link: input.link },
    note,
    origin: input.origin,
  });

  const text = [lead, circle, after, "", `See it in Vestiarion: ${input.link}`, ...(input.txUrl ? [`View the transaction: ${input.txUrl}`] : []), "", note].join("\n");
  return { subject, html, text };
}
