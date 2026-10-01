import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shareReceiptAction, stopSharingReceiptAction } from "@/app/actions/receipts";
import { ReceiptControl, ReceiptLink } from "@/components/ReceiptControl";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { DecisionCard } from "@/components/vx/DecisionCard";
import type { Decision } from "@/components/vx/types";
import { receiptShareable } from "@/lib/receipts/facts";
import { publicOrigin } from "@/lib/public-origin";

/**
 * Sharing a receipt from Invoices (docs/superpowers/specs/2026-10-01-payment-receipts-design.md P3, P6):
 * an owner's or admin's actions in a live workspace, and the control on a paid payable's card. The library
 * is stood in for; tests/receipts-share.test.ts covers it.
 */

const { authorizeMock, lib } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  lib: { shareReceipt: vi.fn(), stopSharingReceipt: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/receipts/share", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/receipts/share")>()), ...lib }));

import { ReceiptError } from "@/lib/receipts/share";

const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001aa";
const TOKEN = `vxr_${"A".repeat(43)}`;
const access = (mode: "live" | "sandbox") => ({ ok: true, user: { id: USER, email: null }, membership: { orgId: "org-1", slug: "testnet-2", name: "Testnet 2", mode, role: "owner" } });

function form(invoiceId = INVOICE): FormData {
  const data = new FormData();
  data.set("orgSlug", "testnet-2");
  data.set("invoiceId", invoiceId);
  return data;
}
const empty = { ok: false, message: "" };
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

beforeEach(() => {
  authorizeMock.mockReset();
  lib.shareReceipt.mockReset();
  lib.stopSharingReceipt.mockReset();
});

describe("shareReceiptAction", () => {
  it("shares a live workspace's payment and gives the link once", async () => {
    authorizeMock.mockResolvedValue(access("live"));
    lib.shareReceipt.mockResolvedValue({ token: TOKEN, receiptId: "rcpt-1", renewed: false });
    expect(await shareReceiptAction(empty, form())).toEqual({
      ok: true,
      message: "Receipt shared. Copy the link now: it is shown only once.",
      url: `${publicOrigin()}/receipt/${TOKEN}`,
    });
    expect(authorizeMock).toHaveBeenCalledWith("testnet-2", "records.write");
    expect(lib.shareReceipt).toHaveBeenCalledWith({ actorId: USER, invoiceId: INVOICE });
  });

  it("says the earlier link stops working when a new one is made", async () => {
    authorizeMock.mockResolvedValue(access("live"));
    lib.shareReceipt.mockResolvedValue({ token: TOKEN, receiptId: "rcpt-1", renewed: true });
    expect((await shareReceiptAction(empty, form())).message).toBe("New link made. The earlier link no longer opens the receipt. Copy it now: it is shown only once.");
  });

  it("refuses a sandbox, someone who may not write records, and an invoice id that is not one", async () => {
    authorizeMock.mockResolvedValue(access("sandbox"));
    expect(await shareReceiptAction(empty, form())).toEqual({ ok: false, message: "A receipt is for a payment on chain, which a live workspace makes." });
    authorizeMock.mockResolvedValue({ ok: false, message: "You do not have permission to do that." });
    expect(await shareReceiptAction(empty, form())).toEqual({ ok: false, message: "You do not have permission to do that." });
    authorizeMock.mockResolvedValue(access("live"));
    expect(await shareReceiptAction(empty, form("nope"))).toEqual({ ok: false, message: "That invoice is not in this workspace." });
    expect(lib.shareReceipt).not.toHaveBeenCalled();
  });

  it("says why a payment cannot be shared, and nothing of an unexpected failure", async () => {
    authorizeMock.mockResolvedValue(access("live"));
    lib.shareReceipt.mockRejectedValueOnce(new ReceiptError("The payee's chain has not minted this payout yet."));
    expect(await shareReceiptAction(empty, form())).toEqual({ ok: false, message: "The payee's chain has not minted this payout yet." });
    lib.shareReceipt.mockRejectedValueOnce(new Error("relation payment_receipts does not exist"));
    expect(await shareReceiptAction(empty, form())).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
  });
});

describe("stopSharingReceiptAction", () => {
  it("revokes the link", async () => {
    authorizeMock.mockResolvedValue(access("live"));
    expect(await stopSharingReceiptAction(empty, form())).toEqual({ ok: true, message: "The receipt's link no longer opens it." });
    expect(lib.stopSharingReceipt).toHaveBeenCalledWith({ actorId: USER, invoiceId: INVOICE });
  });

  it("says a receipt that is not shared is not shared", async () => {
    authorizeMock.mockResolvedValue(access("live"));
    lib.stopSharingReceipt.mockRejectedValueOnce(new ReceiptError("This receipt is not shared."));
    expect(await stopSharingReceiptAction(empty, form())).toEqual({ ok: false, message: "This receipt is not shared." });
  });
});

describe("the receipt control on a paid payable", () => {
  it("offers to share a receipt that is not shared", () => {
    const markup = renderToStaticMarkup(<ReceiptControl orgSlug="testnet-2" invoiceId={INVOICE} shared={false} />);
    expect(text(markup)).toContain("Share receipt");
    expect(text(markup)).not.toContain("Stop sharing");
    expect(markup).toContain(`value="${INVOICE}"`);
  });

  it("says a receipt is shared, and offers a new link or to stop sharing", () => {
    const markup = text(renderToStaticMarkup(<ReceiptControl orgSlug="testnet-2" invoiceId={INVOICE} shared />));
    expect(markup).toContain("Receipt shared");
    expect(markup).toContain("New link");
    expect(markup).toContain("Stop sharing");
  });
});

describe("which payables offer a receipt", () => {
  it("is a paid payable with a transaction on chain: the transfer, or the mint on the payee's chain", () => {
    expect(receiptShareable({ status: "paid", direction: "payable" }, { txHash: `0x${"1".repeat(64)}`, mint: null })).toBe(true);
    expect(receiptShareable({ status: "paid", direction: "payable" }, { txHash: null, mint: { txHash: `0x${"3".repeat(64)}` } })).toBe(true);
  });

  it("is not a simulated payment, one not yet paid, or money received", () => {
    expect(receiptShareable({ status: "paid", direction: "payable" }, { txHash: null, mint: null })).toBe(false);
    expect(receiptShareable({ status: "matched", direction: "payable" }, { txHash: `0x${"1".repeat(64)}`, mint: null })).toBe(false);
    expect(receiptShareable({ status: "paid", direction: "receivable" }, { txHash: `0x${"1".repeat(64)}`, mint: null })).toBe(false);
  });

  it("gives the control a full-width row of its own, never the hashes' cluster, so a long link cannot push it out of the card", () => {
    const decision = {
      id: INVOICE, domain: "ap", action: "Pay", subject: "STM", amount: 2, token: "USDC", outcome: "recorded", outcomeLabel: "Paid",
      reasoning: "Due today.", evidence: [], txHash: `0x${"1".repeat(64)}`, auditSeq: 586, at: "2026-10-01T08:28:28Z",
    } as unknown as Decision;
    const markup = renderToStaticMarkup(<DecisionCard decision={decision} orgSlug="testnet-2" footerAction={<span>RECEIPT-ACTION</span>} />);
    const start = markup.indexOf("flex shrink-0 flex-wrap items-center gap-4");
    const cluster = markup.slice(start, markup.indexOf("</div>", start));
    expect(cluster).toContain("audit #0586");
    expect(cluster).not.toContain("RECEIPT-ACTION");
    expect(markup).toMatch(/data-slot="decision-action"[^>]*>(<[^>]+>)*RECEIPT-ACTION/);
  });

  it("shows a new link whole: it wraps inside the card, beside Copy, with what it shows", () => {
    const url = `https://www.vestiarion.xyz/receipt/vxr_${"k".repeat(43)}`;
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <ReceiptLink url={url} message="Receipt shared. Copy the link now: it is shown only once." />
      </TooltipProvider>
    );
    expect(markup).toContain(`value="${url}"`);
    expect(text(markup)).toContain("Copy");
    expect(text(markup)).toContain("Receipt shared. Copy the link now: it is shown only once. Anyone with this link sees the amount, the payee's address and the transactions, and can check them. It shows no names.");
    expect(markup).toMatch(/class="[^"]*w-full[^"]*"/);
  });

  it("shows the control in the card's footer", () => {
    const decision = {
      id: INVOICE, domain: "ap", action: "Pay", subject: "STM", amount: 2, token: "USDC", outcome: "recorded", outcomeLabel: "Paid",
      reasoning: "Due today.", evidence: [], txHash: `0x${"1".repeat(64)}`, at: "2026-10-01T08:28:28Z",
    } as unknown as Decision;
    const markup = text(renderToStaticMarkup(<DecisionCard decision={decision} orgSlug="testnet-2" footerAction={<ReceiptControl orgSlug="testnet-2" invoiceId={INVOICE} shared={false} />} />));
    expect(markup).toContain("Share receipt");
  });
});

