import { describe, expect, it } from "vitest";
import { chatDraftOf, invoiceOfDraft } from "@/lib/invoice-document/chat-draft";
import type { InvoiceDraftRead } from "@/lib/invoice-document/draft";

/**
 * An invoice a chat read, as the chat holds it until someone presses Add (Telegram bot design R10, Slack design S15):
 * the invoice form's fields when a counterparty matched, why it cannot be added from a chat when it cannot, and the
 * invoice it becomes, checked by the form's own rules. One rule for every chat.
 */

const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1";

function read(fields: Partial<InvoiceDraftRead["draft"]> = {}, counterpartyName: string | null = "Test Freelancer A"): InvoiceDraftRead {
  return {
    draft: {
      vendorName: "Test Freelancer A", invoiceNumber: "TFA-2026-1003", amount: "0.75", currency: "USDC", dueDate: "2026-10-10",
      poReference: null, earlyPayDiscountPct: null, discountDeadline: null, payToAddress: null, memo: "Design review session",
      counterpartyId: COUNTERPARTY, ...fields,
    },
    counterpartyName,
    warnings: [],
    notFound: [],
    modelNote: null,
    reader: "heuristic",
    document: { kind: "pdf", sha256: "a".repeat(64), truncated: false },
  };
}

describe("chatDraftOf", () => {
  it("keeps the form's fields and the document's provenance for a read that can be added", () => {
    expect(chatDraftOf(read())).toEqual({
      reasons: [],
      stored: {
        draft: {
          counterpartyId: COUNTERPARTY, amount: "0.75", currency: "USDC", memo: "Design review session", poReference: "", dueDate: "2026-10-10",
          earlyPayDiscountPct: "", discountDeadline: "",
        },
        document: { kind: "pdf", sha256: "a".repeat(64), reader: "heuristic" },
      },
    });
  });

  it("says why a read cannot be added from a chat: no counterparty, no amount, no due date", () => {
    expect(chatDraftOf(read({ counterpartyId: null }, null))).toEqual({ reasons: ["no counterparty in this workspace matches “Test Freelancer A”"], stored: null });
    expect(chatDraftOf(read({ counterpartyId: null, vendorName: null }, null)).reasons).toEqual(["no counterparty in this workspace matches the invoice's vendor"]);
    expect(chatDraftOf(read({ amount: null, dueDate: null })).reasons).toEqual(["no amount could be read", "no due date could be read"]);
  });

  it("holds the read to the invoice form's rules", () => {
    const { reasons, stored } = chatDraftOf(read({ amount: "-1" }));
    expect(stored).toBeNull();
    expect(reasons).toHaveLength(1);
  });
});

describe("invoiceOfDraft", () => {
  it("is the payable the form would add, with the goods as the person said", () => {
    const { stored } = chatDraftOf(read());
    expect(invoiceOfDraft(stored!, true)).toMatchObject({ direction: "payable", counterpartyId: COUNTERPARTY, amount: "0.75", currency: "USDC", goodsReceived: true });
    expect(invoiceOfDraft(stored!, false)).toMatchObject({ goodsReceived: false });
  });

  it("is nothing for a stored draft the form no longer accepts", () => {
    const { stored } = chatDraftOf(read());
    expect(invoiceOfDraft({ ...stored!, draft: { ...stored!.draft, amount: "not a number" } }, false)).toBeNull();
  });
});
