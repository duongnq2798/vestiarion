import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceiptView as ReceiptViewData } from "@/lib/platform/receipts";

/**
 * The public receipt page (docs/superpowers/specs/2026-10-01-payment-receipts-design.md P5): the payment's
 * facts, the three checks with their results, how to check it yourself, and no names. A dead link shows one
 * sentence. The read is stood in for; tests/receipts-read.test.ts covers it.
 */

const { readReceiptMock } = vi.hoisted(() => ({ readReceiptMock: vi.fn() }));
vi.mock("@/lib/platform/receipts", () => ({ readReceipt: readReceiptMock }));

import ReceiptPage, { metadata } from "@/app/receipt/[token]/page";
import { ReceiptView } from "@/components/receipt/ReceiptView";
import { requiresSession } from "@/lib/auth/routes";

const PAYEE = "0x221b000000000000000000000000000000001bc3";
const MINT = `0x${"3".repeat(64)}`;
const BURN = `0x${"1".repeat(64)}`;
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

function view(overrides: Partial<ReceiptViewData> = {}): ReceiptViewData {
  return {
    facts: { amount: 2, token: "USDC", paidAt: "2026-10-01T08:28:26.857Z", payee: PAYEE, chain: "ARB-SEPOLIA", txHash: MINT, route: "gateway", feeUsdc: 0.107811 },
    entry: {
      seq: 612, actor: "human", domain: "ap", action: "receipt_shared", summary: "Receipt: 2 USDC paid on Arbitrum Sepolia",
      detail: { receipt: { amount: 2 }, records: { seq: 580, hash: "h".repeat(64) } },
      body_hash: "b".repeat(64), signature: "5".repeat(128), prev_hash: "p".repeat(64), hash: "c".repeat(64), signing_key_id: "0123456789abcdef",
    },
    publicKeys: { "0123456789abcdef": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----\n" },
    records: { seq: 580, signingKeyId: "fedcba9876543210" },
    checks: { signed: { ok: true }, recorded: { ok: true }, onChain: { state: "matches", block: 314579095 } },
    ...overrides,
  };
}

// A block body: a function returned from beforeEach is run as the test's teardown, and mockReset returns the mock.
beforeEach(() => {
  readReceiptMock.mockReset();
});

describe("a receipt", () => {
  it("states the payment: amount, chain, payee, route with its fee, and the mint linked to the payee chain's explorer", () => {
    const markup = renderToStaticMarkup(<ReceiptView view={view()} />);
    expect(text(markup)).toContain("2 USDC paid on Arbitrum Sepolia");
    expect(markup).toContain(PAYEE);
    expect(text(markup)).toContain("From a Circle Gateway balance, with a 0.107811 USDC fee");
    expect(markup).toContain(`href="https://sepolia.arbiscan.io/tx/${MINT}"`);
  });

  it("links a CCTP payout's burn on Arc testnet as well as its mint", () => {
    const markup = renderToStaticMarkup(<ReceiptView view={view({ facts: { ...view().facts, chain: "BASE-SEPOLIA", route: "cctp", sourceTxHash: BURN, feeUsdc: 0.054604 } })} />);
    expect(text(markup)).toContain("Through CCTP from Arc testnet, with a 0.054604 USDC fee");
    expect(markup).toContain(`href="https://explorer.testnet.arc.io/tx/${BURN}"`);
    expect(markup).toContain(`href="https://sepolia.basescan.org/tx/${MINT}"`);
  });

  it("says a direct payment is a transfer on Arc testnet", () => {
    const markup = text(renderToStaticMarkup(<ReceiptView view={view({ facts: { ...view().facts, chain: "ARC-TESTNET", route: "direct", feeUsdc: undefined } })} />));
    expect(markup).toContain("A transfer on Arc testnet");
  });

  it("says a direct payment on Arc mainnet is a transfer there (mainnet copy C1)", () => {
    const markup = text(renderToStaticMarkup(<ReceiptView view={view({ facts: { ...view().facts, chain: "ARC", route: "direct", feeUsdc: undefined } })} />));
    expect(markup).toContain("A transfer on Arc mainnet");
    expect(markup).not.toContain("Arc testnet");
  });

  it("gives each check its result, and says all three pass", () => {
    const markup = text(renderToStaticMarkup(<ReceiptView view={view()} />));
    expect(markup).toContain("All three checks pass");
    expect(markup).toContain("Signed by the paying workspace");
    expect(markup).toContain("Ledger entry #612 is signed with the workspace's key 0123456789abcdef. Its hash follows from its content, its signature and the hash of the entry before it.");
    expect(markup).not.toContain("links it into");
    expect(markup).toContain("Recorded when it was paid");
    expect(markup).toContain("Entry #580, written earlier in the same workspace's ledger and signed with its key fedcba9876543210, records this transaction. Its content stays private.");
    expect(markup).toContain("On Arbitrum Sepolia");
    expect(markup).toContain("Block 314579095 holds a transfer of 2 USDC to the payee in this transaction.");
  });

  it("says plainly whether the payment is reconciled or only confirmed, and from which source (settlement lifecycle I17)", () => {
    const reconciled = text(renderToStaticMarkup(<ReceiptView view={view()} />));
    expect(reconciled).toContain("Confirmed by Circle: 1 October 2026, 08:28 UTC");
    expect(reconciled).toContain("Status");
    expect(reconciled).toContain("Reconciled");
    expect(reconciled).toContain(
      "Confirmed by Circle on 1 October 2026, 08:28 UTC, as the paying workspace recorded it. This page found the transfer on Arbitrum Sepolia in block 314579095, and entry #580 in the workspace's signed ledger records it."
    );
    const unread = text(renderToStaticMarkup(<ReceiptView view={view({ checks: { signed: { ok: true }, recorded: { ok: true }, onChain: { state: "unreadable" } } })} />));
    expect(unread).toContain("Not reconciled just now: Arbitrum Sepolia did not answer this page.");
    expect(unread).not.toContain("Reconciled");
  });

  it("says which check did not pass, and what could not be read", () => {
    const markup = text(
      renderToStaticMarkup(
        <ReceiptView
          view={view({
            checks: {
              signed: { ok: false, reason: "The entry's content does not match its body hash." },
              recorded: { ok: true },
              onChain: { state: "unreadable" },
            },
          })}
        />
      )
    );
    expect(markup).toContain("A check does not pass");
    expect(markup).toContain("The entry's content does not match its body hash.");
    expect(markup).toContain("Arbitrum Sepolia did not answer just now. The explorer shows the transaction.");
  });

  it("says the chain could not be read, not that a check failed, when that is all that is missing (receipts review #10)", () => {
    const markup = text(renderToStaticMarkup(<ReceiptView view={view({ checks: { signed: { ok: true }, recorded: { ok: true }, onChain: { state: "unreadable" } } })} />));
    expect(markup).toContain("One check could not be made just now");
    expect(markup).not.toContain("does not pass");
  });

  it("lets anyone check it again: the signed entry, its hashes, the key, and the browser's own check", () => {
    const markup = text(renderToStaticMarkup(<ReceiptView view={view()} />));
    expect(markup).toContain("Check it yourself");
    expect(markup).toContain("receipt_shared");
    expect(markup).toContain("b".repeat(64));
    expect(markup).toContain("BEGIN PUBLIC KEY");
    expect(markup).toContain("sha256(prev_hash || body_hash || signature)");
    expect(markup).toContain("Checking again in your browser");
  });

  it("names no one: no business, payee, person or reasoning", () => {
    const markup = text(renderToStaticMarkup(<ReceiptView view={view()} />));
    expect(markup).toContain("This receipt shows no names.");
    expect(markup).not.toMatch(/STM|Northwind|testnet-2/);
  });
});

describe("a receipt since receipts v2 (docs/superpowers/specs/2026-10-22-receipt-v2-design.md RV4, RV5)", () => {
  const v2 = view({
    facts: { ...view().facts, chain: "ARC-TESTNET", route: "direct", feeUsdc: undefined, invoiceNumber: "INV-2207", networkFeeUsdc: 0.003214, feesPaidBy: "sender" },
    checks: { signed: { ok: true }, recorded: { ok: true }, onChain: { state: "matches", block: 314579095, received: 2 } },
  });

  it("lists the invoice, the fee, who paid it, what left the sender and what the payee received, read on chain", () => {
    const markup = text(renderToStaticMarkup(<ReceiptView view={v2} />));
    expect(markup).toContain("Amounts");
    expect(markup).toContain("Invoice INV-2207");
    expect(markup).toContain("Arc testnet network fee 0.003214 USDC");
    expect(markup).toContain("Fees paid by The sender, on top of the amount.");
    expect(markup).toContain("Left the sender 2.003214 USDC");
    expect(markup).toContain("Payee received 2 USDC, read on Arc testnet");
  });

  it("names a route's fee under Amounts, not beside the route", () => {
    const gateway = view({ facts: { ...view().facts, feesPaidBy: "sender" } });
    const markup = text(renderToStaticMarkup(<ReceiptView view={gateway} />));
    expect(markup).toContain("From a Circle Gateway balance");
    expect(markup).not.toContain("with a 0.107811 USDC fee");
    expect(markup).toContain("Gateway fee 0.107811 USDC");
  });

  it("saves as a PDF through the browser's print, which leaves the site's chrome and the disclosure out and prints the entry", async () => {
    const markup = renderToStaticMarkup(<ReceiptView view={v2} />);
    expect(text(markup)).toContain("Save as PDF");
    expect(markup).toMatch(/class="[^"]*print:hidden[^"]*"[^>]*>(?:(?!<\/button>).)*Save as PDF/s);
    expect(markup).toContain(`Ledger entry #612, hash ${"c".repeat(64)}, signed with key 0123456789abcdef.`);
    expect(markup).toMatch(/class="[^"]*hidden[^"]*print:block/);
    readReceiptMock.mockResolvedValue(v2);
    const page = renderToStaticMarkup(await ReceiptPage({ params: Promise.resolve({ token: `vxr_${"A".repeat(43)}` }) }));
    expect(page.match(/<div class="print:hidden">/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the receipt page", () => {
  it("is not indexed, and needs no session", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(requiresSession(`/receipt/vxr_${"A".repeat(43)}`)).toBe(false);
  });

  it("shows the receipt for a live link", async () => {
    readReceiptMock.mockResolvedValue(view());
    const markup = text(renderToStaticMarkup(await ReceiptPage({ params: Promise.resolve({ token: `vxr_${"A".repeat(43)}` }) })));
    expect(markup).toContain("2 USDC paid on Arbitrum Sepolia");
  });

  it("shows one sentence for a dead link, naming no one", async () => {
    readReceiptMock.mockResolvedValue(null);
    expect(text(renderToStaticMarkup(await ReceiptPage({ params: Promise.resolve({ token: "anything" }) })))).toContain("This receipt link is no longer valid.");
  });

  it("says it could not load, rather than that the link is dead, when the read fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    readReceiptMock.mockRejectedValue(new Error("db down"));
    expect(text(renderToStaticMarkup(await ReceiptPage({ params: Promise.resolve({ token: "anything" }) })))).toContain("This receipt could not load. Try again in a moment.");
  });
});
