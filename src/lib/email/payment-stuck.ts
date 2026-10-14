import { networkProfile, type Network } from "../network";
import { runbookHref } from "../payment-exceptions";
import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/** One payment that has not confirmed, as the email words it. */
export interface StuckPayment {
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
}

/**
 * The email a workspace's deciding members get about payments that have not confirmed (docs/superpowers/specs/
 * 2026-10-06-stuck-transfer-alert-design.md D6, D7): one message to each person each run, listing each payment, how long
 * ago it was submitted and on which network, and what Circle says, and that Vestiarion sends nothing again while a payment
 * may still settle. Speeding up or cancelling a transfer stays out of scope, as the failed-transfer retry design ruled.
 */
export function paymentStuckEmail(input: {
  orgName: string;
  payments: StuckPayment[];
  /** The button's link: the one payment's page, or the workspace's Bills & receivables page for several. */
  link: string;
  origin: string;
}): { subject: string; html: string; text: string } {
  const [first] = input.payments;
  const subject =
    input.payments.length === 1
      ? `A payment of ${first.amount} ${first.currency} to ${first.payeeName} has not confirmed`
      : `${input.payments.length} payments have not confirmed`;
  const after = "Vestiarion sends nothing again while a payment may still settle, and checks it again at the next cycle.";
  const note = `You get this email because you can approve payments in ${input.orgName} and have email notices on.`;
  // The runbook's section for the one payment's state, or its page for several (payment exceptions E6).
  const runbook = `${input.origin}${input.payments.length === 1 ? runbookHref(first.sendAnswered ? "stuck" : "unknown") : runbookHref()}`;

  const html = actionEmailHtml({
    title: subject,
    preheader: lead(first),
    eyebrow: "Payment not confirmed",
    heading: input.payments.length === 1 ? "A payment has not confirmed" : "Payments have not confirmed",
    paragraphsHtml: [
      ...input.payments.flatMap((payment) => [
        escapeHtml(lead(payment)),
        escapeHtml(circleLine(payment)),
        ...(input.payments.length > 1 ? [`<a href="${escapeHtml(payment.link)}" style="color:#18211c;">See it in Vestiarion</a>`] : []),
        ...(payment.txUrl ? [`<a href="${escapeHtml(payment.txUrl)}" style="color:#18211c;">View the transaction</a>`] : []),
      ]),
      escapeHtml(after),
      `<a href="${escapeHtml(runbook)}" style="color:#18211c;">What to do when a payment does not settle</a>`,
    ],
    button: { label: "See it in Vestiarion", link: input.link },
    note,
    origin: input.origin,
  });

  const blocks = input.payments.map((payment) =>
    [lead(payment), circleLine(payment), `See it in Vestiarion: ${payment.link}`, ...(payment.txUrl ? [`View the transaction: ${payment.txUrl}`] : [])].join("\n")
  );
  const text = [blocks.join("\n\n"), "", after, `What to do: ${runbook}`, "", note].join("\n");
  return { subject, html, text };
}

/** Submitted, never "sent": until Circle confirms it, a payment may not have moved, and Circle may not have taken it (I17). */
function lead(payment: StuckPayment): string {
  const { label } = networkProfile(payment.network);
  return `The payment of ${payment.amount} ${payment.currency} to ${payment.payeeName}, submitted to Circle ${payment.minutes} minutes ago on ${label}, has not confirmed.`;
}

/** What Circle said (D7), or that it was not asked, or never answered the send, whose outcome is then unknown (L3). */
function circleLine(payment: StuckPayment): string {
  if (!payment.sendAnswered) return "Circle never answered when it was submitted, so the outcome is unknown: Circle may or may not have taken the transfer.";
  if (!payment.circleAsked) return "Vestiarion could not ask Circle about it just now.";
  if (payment.providerState === "STUCK") return "Circle shows it stuck: check it in Circle's console, or contact Circle support.";
  return `Circle shows it as ${payment.providerState ?? "pending"}.`;
}
