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
    expect(markup).toContain(`href="https://testnet.arcscan.app/tx/${BURN}"`);
    expect(markup).toContain(`href="https://sepolia.basescan.org/tx/${MINT}"`);
  });

  it("says a direct payment is a transfer on Arc testnet", () => {
    const markup = text(renderToStaticMarkup(<ReceiptView view={view({ facts: { ...view().facts, chain: "ARC-TESTNET", route: "direct", feeUsdc: undefined } })} />));
    expect(markup).toContain("A transfer on Arc testnet");
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
