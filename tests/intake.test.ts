import { describe, expect, it } from "vitest";
import { parseInvoiceCsv } from "@/lib/invoice-csv";
import { counterpartyInputSchema, csvInvoiceInputSchema, invoiceInputSchema, usdcAmountSchema } from "@/lib/intake-validation";

describe("USDC intake precision", () => {
  it.each(["0.000001", "100.123456", "1", "99999999999999.999999", " 42.50 "])("accepts %s without numeric coercion", (amount) => {
    expect(usdcAmountSchema.parse(amount)).toBe(amount.trim());
  });

  it.each(["0", "0.000000", "-1", "+1", "1e3", "1,000", "1.0000001", "100000000000000", "01.00", "NaN", "Infinity", ""])("rejects %s rather than rounding or reinterpreting it", (amount) => {
    expect(usdcAmountSchema.safeParse(amount).success).toBe(false);
  });
});

describe("counterparty intake", () => {
  const base = { name: "Example Supplier", role: "vendor", address: "", chain: "ARC-TESTNET", jurisdiction: "US", paymentLimit: "5000.00" };

  it("requires a configured limit for vendors and contractors", () => {
    expect(counterpartyInputSchema.safeParse({ ...base, paymentLimit: "" }).success).toBe(false);
    expect(counterpartyInputSchema.safeParse({ ...base, role: "contractor", paymentLimit: "" }).success).toBe(false);
  });

  it("allows a client with no outbound payment authority", () => {
    const result = counterpartyInputSchema.safeParse({ ...base, role: "client", paymentLimit: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.paymentLimit).toBe("");
  });
});

describe("invoice intake", () => {
  const base = {
    direction: "payable",
    counterpartyId: "71b2cfb1-c3d9-4cde-b726-73438bb5af91",
    amount: "10.50",
    memo: "Services",
    poReference: "PO-42",
    goodsReceived: true,
    dueDate: "2026-10-31",
  };

  it("accepts a real calendar date", () => {
    expect(invoiceInputSchema.safeParse(base).success).toBe(true);
  });

  it.each(["2026-02-30", "2026-13-01", "31-10-2026", ""])("rejects invalid due date %s", (dueDate) => {
    expect(invoiceInputSchema.safeParse({ ...base, dueDate }).success).toBe(false);
  });

  it("normalizes supported CSV boolean values", () => {
    for (const value of ["true", "yes", "1", true]) {
      const result = csvInvoiceInputSchema.parse({
        direction: "payable",
        counterparty: "Example Supplier",
        amount: "1.00",
        memo: "",
        po_reference: "",
        goods_received: value,
        due_date: "2026-10-31",
      });
      expect(result.goods_received).toBe(true);
    }
  });
});

describe("invoice CSV parser", () => {
  const header = "direction,counterparty,amount,memo,po_reference,goods_received,due_date";

  it("handles CRLF, quoted commas, escaped quotes, and embedded newlines", () => {
    const rows = parseInvoiceCsv(`${header}\r\npayable,"Acme, Inc",100.00,"Design ""system""\nphase 1",PO-9,yes,2026-10-31\r\n`);
    expect(rows).toEqual([{
      direction: "payable",
      counterparty: "Acme, Inc",
      amount: "100.00",
      memo: "Design \"system\"\nphase 1",
      po_reference: "PO-9",
      goods_received: "yes",
      due_date: "2026-10-31",
    }]);
  });

  it("accepts columns in any order and ignores extra columns", () => {
    const rows = parseInvoiceCsv("amount,due date,direction,counterparty,memo,goods received,po reference,ignored\n1.00,2026-10-31,receivable,Client A,Retainer,no,,x");
    expect(rows[0]).toMatchObject({ direction: "receivable", counterparty: "Client A", amount: "1.00", goods_received: "no" });
  });

  it("rejects a missing required header", () => {
    expect(() => parseInvoiceCsv("direction,counterparty,amount\npayable,Acme,1.00")).toThrow("Missing CSV columns");
  });

  it("rejects an unclosed quoted field", () => {
    expect(() => parseInvoiceCsv(`${header}\npayable,"Acme,1.00,memo,PO-1,true,2026-10-31`)).toThrow("unclosed quoted field");
  });

  it("requires at least one invoice row", () => {
    expect(() => parseInvoiceCsv(header)).toThrow("at least one invoice row");
  });
});
