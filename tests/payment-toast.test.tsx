import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentReceipt } from "@/lib/payment-receipt";

/**
 * A person's payment, told in three steps that never run ahead of the money: approved and sending while the action
 * runs, then confirmed, or sent and processing while the network confirms it. Each reads in the order a person asks:
 * has it gone, how much, to whom, who decided it, on which network, and where to check it.
 */

const { toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("@/components/ui/Toaster", () => ({ toast: toastMock }));

import { paymentReceiptToast, paymentSendingToast, paymentToastId, withPaymentReceipt } from "@/components/payment-toast";
import { withSuccessToast } from "@/components/withSuccessToast";

const TX_URL = `https://explorer.testnet.arc.io/tx/0x${"ab".repeat(32)}`;

const CONFIRMED: PaymentReceipt = {
  state: "confirmed",
  amount: 4.5,
  currency: "USDC",
  payee: "Design Studio",
  network: "Arc testnet",
  decidedBy: "verdict",
  txUrl: TX_URL,
  fromReserve: null,
};

const html = (node: unknown) => renderToStaticMarkup(node as ReactElement);

/** The text a person reads, in order, without markup. */
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

beforeEach(() => {
  toastMock.success.mockReset();
  toastMock.info.mockReset();
  toastMock.loading.mockReset();
  toastMock.dismiss.mockReset();
});

describe("paymentReceiptToast", () => {
  it("says the payment is confirmed first, then how much, to whom, who decided it, where and who confirmed it, and the transaction", () => {
    paymentReceiptToast(CONFIRMED, "payment-inv-1");

    const [title, options] = toastMock.success.mock.calls[0];
    expect(title).toBe("Payment confirmed");
    expect(options).toMatchObject({ id: "payment-inv-1", duration: 10_000, closeButton: true });
    const markup = html(options.description);
    const read = text(markup);
    const order = ["4.50", "USDC", "Paid to Design Studio", "Agent decision approved by you", "Confirmed by Circle on Arc testnet", "View transaction"].map((part) =>
      read.indexOf(part)
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A quiet link, not a button: the payment is what the toast says, the transaction is where to check it.
    expect(markup).toContain(`href="${TX_URL}"`);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).not.toContain("<button");
  });

  it("calls a payment Circle has not confirmed processing and submitted, never confirmed, sent or paid (I17)", () => {
    paymentReceiptToast({ ...CONFIRMED, state: "confirming", txUrl: null });

    expect(toastMock.success).not.toHaveBeenCalled();
    // Not a success: a type of its own, so it also replaces the sending notice's spinner.
    const [title, options] = toastMock.info.mock.calls[0];
    expect(title).toBe("Payment processing");
    expect(options).toMatchObject({ closeButton: true });
    const read = text(html(options.description));
    expect(read).toContain("Submitted to Circle for Design Studio");
    expect(read).toContain("Waiting for Circle to confirm it on Arc testnet");
    expect(read).not.toMatch(/\b(sent|paid)\b/i);
    // Circle's own id is not a transaction the explorer opens.
    expect(read).not.toContain("View transaction");
  });

  it("says a send Circle never answered has an unknown outcome, never that it was sent or paid", () => {
    paymentReceiptToast({ ...CONFIRMED, state: "confirming", outcomeUnknown: true, txUrl: null });

    const [title, options] = toastMock.info.mock.calls[0];
    expect(title).toBe("Payment processing");
    const read = text(html(options.description));
    expect(read).toContain("Submitted to Circle for Design Studio");
    expect(read).toContain("Circle has not answered yet, so the outcome is unknown; nothing goes out again until it does");
    expect(read).not.toMatch(/\b(sent|paid)\b/i);
  });

  it("calls a payment the sandbox simulated simulated, never confirmed by Circle", () => {
    paymentReceiptToast({ ...CONFIRMED, network: "Sandbox (simulated)", txUrl: null });

    const [title, options] = toastMock.success.mock.calls[0];
    expect(title).toBe("Payment simulated");
    const read = text(html(options.description));
    expect(read).toContain("Simulated payment to Design Studio");
    expect(read).toContain("Sandbox (simulated)");
    expect(read).not.toContain("Circle");
    expect(read).not.toContain("Paid to");
  });

  it("says a person approved it when it was not the agent's decision to pay, and what the reserve gave back", () => {
    paymentReceiptToast({ ...CONFIRMED, decidedBy: "approval", fromReserve: "1.2 USDC came back from the USYC reserve first." });

    const read = text(html(toastMock.success.mock.calls[0][1].description));
    expect(read).toContain("Approved by you");
    expect(read).not.toContain("Agent decision");
    expect(read).toContain("1.2 USDC came back from the USYC reserve first.");
  });
});

describe("paymentSendingToast", () => {
  it("says the payment is approved and being sent, under the id its confirmation replaces", () => {
    paymentSendingToast(paymentToastId("inv-1"), { amount: 4.5, currency: "USDC", payee: "Design Studio", decidedBy: "verdict" });

    const [title, options] = toastMock.loading.mock.calls[0];
    expect(title).toBe("Payment approved");
    expect(options.id).toBe("payment-inv-1");
    const read = text(html(options.description));
    expect(read).toContain("4.50");
    expect(read).toContain("Sending to Design Studio");
    expect(read).toContain("Agent decision approved by you");
    expect(read).not.toContain("View transaction");
  });
});

describe("paymentSendingToast for a payment whose earlier transfer is checked first (payment exceptions E3)", () => {
  it("says it is checking the transfer already sent, never sending", () => {
    paymentSendingToast(paymentToastId("inv-2"), { amount: 4.5, currency: "USDC", payee: "Design Studio", decidedBy: "approval" }, "check");

    const read = text(html(toastMock.loading.mock.calls[0][1].description));
    expect(read).toContain("Checking the transfer already sent to Design Studio");
    expect(read).not.toContain("Sending");
  });

  it("says it is looking for the earlier transfer on Circle first, for a send Circle never answered", () => {
    paymentSendingToast(paymentToastId("inv-3"), { amount: 4.5, currency: "USDC", payee: "Design Studio", decidedBy: "approval" }, "look_first");

    const read = text(html(toastMock.loading.mock.calls[0][1].description));
    expect(read).toContain("Looking for the earlier transfer to Design Studio on Circle first");
    expect(read).not.toContain("Sending");
  });
});

describe("withPaymentReceipt", () => {
  type Result = { ok: boolean; message: string; receipt?: PaymentReceipt };
  const form = () => {
    const data = new FormData();
    data.set("invoiceId", "inv-1");
    return data;
  };

  it("replaces the sending notice with the payment's confirmation", async () => {
    const action = withPaymentReceipt(async (): Promise<Result> => ({ ok: true, message: "Paid 4.50 USDC to Design Studio on Arc testnet.", receipt: CONFIRMED }));
    await action({ ok: false, message: "" }, form());
    expect(toastMock.success).toHaveBeenCalledWith("Payment confirmed", expect.objectContaining({ id: "payment-inv-1" }));
    expect(toastMock.dismiss).not.toHaveBeenCalled();
  });

  it("takes the sending notice away when nothing was paid, and says what was done instead", async () => {
    const recorded = withPaymentReceipt(async (): Promise<Result> => ({ ok: true, message: "Your approval is recorded. A second person's approval pays it." }));
    await recorded({ ok: false, message: "" }, form());
    expect(toastMock.dismiss).toHaveBeenCalledWith("payment-inv-1");
    expect(toastMock.success).toHaveBeenCalledWith("Your approval is recorded. A second person's approval pays it.");

    toastMock.success.mockReset();
    const refused = withPaymentReceipt(async (): Promise<Result> => ({ ok: false, message: "The payee's address changed." }));
    await refused({ ok: false, message: "" }, form());
    expect(toastMock.dismiss).toHaveBeenCalledTimes(2);
    // A refusal stays in the form that caused it.
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("takes the sending notice away when the action fails outright", async () => {
    const action = withPaymentReceipt(async (): Promise<{ ok: boolean; message: string }> => {
      throw new Error("network");
    });
    await expect(action({ ok: false, message: "" }, form())).rejects.toThrow("network");
    expect(toastMock.dismiss).toHaveBeenCalledWith("payment-inv-1");
  });
});

describe("withSuccessToast", () => {
  it("raises the action's own words", async () => {
    const action = withSuccessToast(async (): Promise<{ ok: boolean; message: string }> => ({ ok: true, message: "Rejected." }));
    await action({ ok: false, message: "" }, new FormData());
    expect(toastMock.success).toHaveBeenCalledWith("Rejected.");
  });
});
