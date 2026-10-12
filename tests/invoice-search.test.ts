import { describe, expect, it } from "vitest";
import { invoiceMatch, parseSearch, paymentMatches, type SearchableInvoice } from "@/lib/invoice-search";
import { toMicros, type PaymentIn } from "@/lib/allocations/model";

/**
 * Search on Bills & receivables (docs/superpowers/specs/2026-10-12-allocations-design.md L14, I09): an invoice is found
 * by its Vestiarion id, its invoice number or a word of its memo, its purchase order, its counterparty, its amount or
 * what is still owed, and a payment applied to it by its transaction hash, Circle id or sender.
 */

const ID = "018f8ce0-1557-7b54-a931-4d777f6ba071";
const TX = `0x${"ab12".repeat(16)}`;
const SENDER = "0x2222222222222222222222222222222222222222";

const invoice: SearchableInvoice = {
  id: ID,
  memo: "Invoice KP-1042: Copy paper",
  po_reference: "PO-7781",
  counterparty_name: "Northwind Hosting",
  amount: 1250,
};
const applied = { outstanding: toMicros(300), payments: [{ txHash: TX, circleTxId: "c0ffee-1234-5678", from: SENDER }] };
const find = (raw: string, extras = applied) => {
  const query = parseSearch(raw);
  return query ? invoiceMatch(query, invoice, extras) : "no query";
};

describe("parseSearch", () => {
  it("reads nothing from an empty or blank box, and keeps a query short", () => {
    expect(parseSearch(undefined)).toBeNull();
    expect(parseSearch("   ")).toBeNull();
    expect(parseSearch("x".repeat(500))?.text).toHaveLength(100);
  });

  it("reads an amount typed two ways", () => {
    expect(parseSearch("1250")?.amount).toBe(toMicros(1250));
    expect(parseSearch("1,250.00")?.amount).toBe(toMicros(1250));
    expect(parseSearch("Northwind")?.amount).toBeNull();
  });
});

describe("an invoice is found by", () => {
  it("its Vestiarion id, whole or its first characters", () => {
    expect(find(ID)).toBe("id");
    expect(find(ID.slice(0, 8).toUpperCase())).toBe("id");
    expect(find("018f")).not.toBe("id");
  });

  it("its invoice number, or any word of its memo", () => {
    expect(find("KP-1042")).toBe("memo");
    expect(find("copy paper")).toBe("memo");
  });

  it("its purchase order", () => {
    expect(find("po-7781")).toBe("po");
  });

  it("its counterparty", () => {
    expect(find("northwind")).toBe("counterparty");
  });

  it("its amount, or what is still owed on it", () => {
    expect(find("1,250.00")).toBe("amount");
    expect(find("300")).toBe("outstanding");
  });

  it("a payment applied to it: its transaction hash, Circle id or sender", () => {
    expect(find(TX.slice(0, 12))).toBe("payment");
    expect(find(TX.toUpperCase())).toBe("payment");
    expect(find("c0ffee-1234")).toBe("payment");
    expect(find(SENDER)).toBe("payment");
  });

  it("and nothing else", () => {
    expect(find("acme")).toBeNull();
    expect(find("999")).toBeNull();
    // Too short a piece of a hash finds nothing by it.
    expect(find("0xab")).toBeNull();
  });
});

describe("paymentMatches", () => {
  const payment: PaymentIn = {
    id: "p-1",
    circleTxId: "c0ffee-1234-5678",
    txHash: TX,
    from: SENDER,
    amount: toMicros(900),
    currency: "USDC",
    receivedAt: "2026-10-12T09:00:00Z",
    wholeMatch: null,
  };

  it("finds a payment by its hash, Circle id, sender or amount", () => {
    for (const raw of [TX, TX.slice(0, 10), "c0ffee-1234", SENDER, "900", "900.00"]) expect(paymentMatches(parseSearch(raw)!, payment), raw).toBe(true);
    expect(paymentMatches(parseSearch("901")!, payment)).toBe(false);
    expect(paymentMatches(parseSearch("Northwind")!, payment)).toBe(false);
  });
});
