import { describe, expect, it } from "vitest";
import { paymentStuckEmail } from "@/lib/email/payment-stuck";

/**
 * The email a workspace's deciding members get about a payment that has not confirmed (docs/superpowers/specs/
 * 2026-10-06-stuck-transfer-alert-design.md D6, D7): which payment, how long ago and on which network, what Circle says,
 * and that nothing is sent again while it may still settle.
 */

const TX = `0x${"ab".repeat(32)}`;
const base = {
  orgName: "Acme <Ops>",
  payeeName: "Jiren",
  amount: "12.50",
  currency: "USDC",
  minutes: 18,
  network: "arc-mainnet" as const,
  circleAsked: true,
  sendAnswered: true,
  providerState: "SENT" as string | null,
  txUrl: `https://explorer.arc.io/tx/${TX}` as string | null,
  link: "https://www.vestiarion.xyz/o/acme/invoices#trail-inv-1",
  origin: "https://www.vestiarion.xyz",
};

describe("the email about a payment that has not confirmed", () => {
  it("says which payment, how long ago, on which network, what Circle says, and that nothing is sent again", () => {
    const email = paymentStuckEmail(base);
    expect(email.subject).toBe("A payment of 12.50 USDC to Jiren has not confirmed");
    for (const part of [email.text, email.html]) {
      expect(part).toContain("The payment of 12.50 USDC to Jiren, sent 18 minutes ago on Arc mainnet, has not confirmed.");
      expect(part).toContain("Circle shows it as SENT.");
      expect(part).toContain("Vestiarion sends nothing again while it may still settle, and checks it again at the next cycle.");
    }
    expect(email.text).toContain(`See it in Vestiarion: ${base.link}`);
    expect(email.text).toContain(`View the transaction: ${base.txUrl}`);
  });

  it("says what to do about a transfer Circle shows stuck", () => {
    expect(paymentStuckEmail({ ...base, providerState: "STUCK" }).text).toContain(
      "Circle shows it stuck: check it in Circle's console, or contact Circle support."
    );
  });

  it("says when Circle could not be asked, and when it never answered the send", () => {
    expect(paymentStuckEmail({ ...base, circleAsked: false, providerState: null }).text).toContain("Vestiarion could not ask Circle about it just now.");
    const unanswered = paymentStuckEmail({ ...base, circleAsked: false, sendAnswered: false, providerState: null, txUrl: null });
    expect(unanswered.text).toContain("Circle never answered when it was sent, so it may not have taken the transfer.");
    expect(unanswered.text).not.toContain("View the transaction");
  });

  it("names Arc testnet for a payment there, and escapes names in the HTML", () => {
    const email = paymentStuckEmail({ ...base, network: "arc-testnet", payeeName: "Jiren <b>" });
    expect(email.text).toContain("sent 18 minutes ago on Arc testnet");
    expect(email.html).toContain("Jiren &lt;b&gt;");
    expect(email.html).not.toContain("Jiren <b>");
    expect(email.html).toContain("Acme &lt;Ops&gt;");
    expect(email.html).not.toContain("Acme <Ops>");
  });
});
