import { describe, expect, it } from "vitest";
import { paymentStuckEmail, type StuckPayment } from "@/lib/email/payment-stuck";

/**
 * The email a workspace's deciding members get about payments that have not confirmed (docs/superpowers/specs/
 * 2026-10-06-stuck-transfer-alert-design.md D6, D7): one message per person each run, listing each payment, how long ago
 * and on which network, what Circle says, and that nothing is sent again while it may still settle.
 */

const TX = `0x${"ab".repeat(32)}`;
const payment: StuckPayment = {
  payeeName: "Jiren",
  amount: "12.50",
  currency: "USDC",
  minutes: 18,
  network: "arc-mainnet",
  circleAsked: true,
  sendAnswered: true,
  providerState: "SENT",
  txUrl: `https://explorer.arc.io/tx/${TX}`,
  link: "https://www.vestiarion.xyz/o/acme/invoices#trail-inv-1",
};
const email = (payments: StuckPayment[], orgName = "Acme <Ops>") =>
  paymentStuckEmail({ orgName, payments, link: payments.length === 1 ? payments[0].link : "https://www.vestiarion.xyz/o/acme/invoices", origin: "https://www.vestiarion.xyz" });

describe("the email about payments that have not confirmed", () => {
  it("says which payment, how long ago, on which network, what Circle says, and that nothing is sent again", () => {
    const one = email([payment]);
    expect(one.subject).toBe("A payment of 12.50 USDC to Jiren has not confirmed");
    for (const part of [one.text, one.html]) {
      expect(part).toContain("The payment of 12.50 USDC to Jiren, sent 18 minutes ago on Arc mainnet, has not confirmed.");
      expect(part).toContain("Circle shows it as SENT.");
      expect(part).toContain("Vestiarion sends nothing again while a payment may still settle, and checks it again at the next cycle.");
    }
    expect(one.text).toContain(`See it in Vestiarion: ${payment.link}`);
    expect(one.text).toContain(`View the transaction: ${payment.txUrl}`);
  });

  it("lists several payments in one message", () => {
    const several = email([payment, { ...payment, payeeName: "Puka Hotel", amount: "1.00", providerState: "QUEUED", link: "https://www.vestiarion.xyz/o/acme/contractors" }]);
    expect(several.subject).toBe("2 payments have not confirmed");
    expect(several.text).toContain("The payment of 12.50 USDC to Jiren, sent 18 minutes ago on Arc mainnet, has not confirmed.");
    expect(several.text).toContain("The payment of 1.00 USDC to Puka Hotel, sent 18 minutes ago on Arc mainnet, has not confirmed.");
    expect(several.text).toContain("https://www.vestiarion.xyz/o/acme/contractors");
  });

  it("says what to do about a transfer Circle shows stuck", () => {
    expect(email([{ ...payment, providerState: "STUCK" }]).text).toContain("Circle shows it stuck: check it in Circle's console, or contact Circle support.");
  });

  it("says when Circle could not be asked, and when it never answered the send", () => {
    expect(email([{ ...payment, circleAsked: false, providerState: null }]).text).toContain("Vestiarion could not ask Circle about it just now.");
    const unanswered = email([{ ...payment, circleAsked: false, sendAnswered: false, providerState: null, txUrl: null }]);
    expect(unanswered.text).toContain("Circle never answered when it was sent, so it may not have taken the transfer.");
    expect(unanswered.text).not.toContain("View the transaction");
  });

  it("names Arc testnet for a payment there, and escapes names in the HTML", () => {
    const testnet = email([{ ...payment, network: "arc-testnet", payeeName: "Jiren <b>" }]);
    expect(testnet.text).toContain("sent 18 minutes ago on Arc testnet");
    expect(testnet.html).toContain("Jiren &lt;b&gt;");
    expect(testnet.html).not.toContain("Jiren <b>");
    expect(testnet.html).toContain("Acme &lt;Ops&gt;");
    expect(testnet.html).not.toContain("Acme <Ops>");
  });
});
