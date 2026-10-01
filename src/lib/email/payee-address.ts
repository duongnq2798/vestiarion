import { escapeHtml } from "./html";
import { actionEmailHtml } from "./layout";

/**
 * The email a workspace's approvers get when a payee adds their address
 * through a link (docs/superpowers/specs/2026-10-01-pay-a-freelancer-design.md
 * §2, R4): the address, and that nothing is paid to it until one of them
 * confirms it on Counterparties.
 */
export function payeeAddressEmail(input: {
  orgName: string;
  payeeName: string;
  address: string;
  link: string;
  origin: string;
}): { subject: string; html: string; text: string } {
  const { orgName, payeeName, address, link, origin } = input;
  const subject = `${payeeName} added an address to be paid at`;
  const lead = `${payeeName} added the address they want ${orgName} to pay them at:`;
  const hold =
    "Nothing is paid to it until someone confirms it. Check it with them if you can, then confirm it on Counterparties; the agent pays within a minute.";

  const html = actionEmailHtml({
    title: subject,
    preheader: `${lead} ${address}`,
    eyebrow: "Address to confirm",
    heading: subject,
    paragraphsHtml: [
      escapeHtml(lead),
      `<span style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:13px;word-break:break-all;color:#18211c;">${escapeHtml(address)}</span>`,
      escapeHtml(hold),
    ],
    button: { label: "Open Counterparties", link },
    note: `Sent to the people in ${orgName} who can confirm addresses.`,
    origin,
  });

  const text = [lead, address, "", hold, link].join("\n");
  return { subject, html, text };
}
