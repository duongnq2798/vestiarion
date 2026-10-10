import { describe, expect, it } from "vitest";
import { counterpartyInputSchema, firstZodMessage, invoiceFormRefusal, invoiceInputSchema, usdcAmountSchema } from "@/lib/intake-validation";

describe("USDC intake precision", () => {
  it.each(["0.000001", "100.123456", "1", "99999999999999.999999", " 42.50 "])("accepts %s without numeric coercion", (amount) => {
    expect(usdcAmountSchema.parse(amount)).toBe(amount.trim());
  });

  it.each(["0", "0.000000", "-1", "+1", "1e3", "1,000", "1.0000001", "100000000000000", "01.00", "NaN", "Infinity", ""])("rejects %s rather than rounding or reinterpreting it", (amount) => {
    expect(usdcAmountSchema.safeParse(amount).success).toBe(false);
  });
});

describe("counterparty intake: the address (payment safety A1)", () => {
  const base = { name: "Example Supplier", role: "vendor", chain: "ARC-TESTNET", jurisdiction: "US", paymentLimit: "5000.00" };

  it("keeps a valid address and an empty one as none", () => {
    expect(counterpartyInputSchema.parse({ ...base, address: " 0x840de234Bfc3F66fA380888A0a8204D9487D60d4 " }).address).toBe("0x840de234Bfc3F66fA380888A0a8204D9487D60d4");
    expect(counterpartyInputSchema.parse({ ...base, address: "" }).address).toBeNull();
  });

  it("refuses anything that is not an Arc address, and a checksum that does not match, before anything is saved", () => {
    for (const address of ["0x1234", "vitalik.eth", "0x840De234Bfc3F66fA380888A0a8204D9487D60d4"]) {
      const result = counterpartyInputSchema.safeParse({ ...base, address });
      expect(result.success, address).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["address"]);
    }
  });
});

describe("counterparty intake", () => {
  const base = { name: "Example Supplier", role: "vendor", address: "", chain: "ARC-TESTNET", jurisdiction: "US", paymentLimit: "5000.00" };

  it("requires a configured limit for vendors and contractors", () => {
    expect(counterpartyInputSchema.safeParse({ ...base, paymentLimit: "" }).success).toBe(false);
    expect(counterpartyInputSchema.safeParse({ ...base, role: "contractor", paymentLimit: "" }).success).toBe(false);
  });

  it("takes a chain Vestiarion can pay on, without regard to case, and refuses any other (CCTP payouts X1)", () => {
    for (const chain of ["ARC-TESTNET", "base-sepolia", "ARB-SEPOLIA", "ETH-SEPOLIA"]) {
      const result = counterpartyInputSchema.safeParse({ ...base, chain });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.chain).toBe(chain.toUpperCase());
    }
    const elsewhere = counterpartyInputSchema.safeParse({ ...base, chain: "POLYGON-AMOY" });
    expect(elsewhere.success).toBe(false);
    if (!elsewhere.success) expect(firstZodMessage(elsewhere.error)).toContain("Choose a chain Vestiarion can pay on");
  });

  it("pays only a vendor on another chain: a contractor's milestones are released on the workspace's own chain (review C1, mainnet polish E4)", () => {
    const contractor = counterpartyInputSchema.safeParse({ ...base, role: "contractor", chain: "BASE-SEPOLIA" });
    expect(contractor.success).toBe(false);
    if (!contractor.success) {
      expect(firstZodMessage(contractor.error)).toContain("Only a vendor can be paid on another chain; a contractor's milestones are released on the workspace's own chain.");
      expect(firstZodMessage(contractor.error)).not.toContain("Arc testnet");
    }
    expect(counterpartyInputSchema.safeParse({ ...base, role: "contractor", chain: "ARC-TESTNET" }).success).toBe(true);
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
    earlyPayDiscountPct: "",
    discountDeadline: "",
  };

  it("accepts a real calendar date", () => {
    expect(invoiceInputSchema.safeParse(base).success).toBe(true);
  });

  describe("currency (EURC invoices design E1)", () => {
    it("is USDC unless the invoice says EURC", () => {
      expect(invoiceInputSchema.parse(base).currency).toBe("USDC");
      expect(invoiceInputSchema.parse({ ...base, currency: "EURC" }).currency).toBe("EURC");
      expect(invoiceInputSchema.parse({ ...base, currency: "" }).currency).toBe("USDC");
    });

    it.each(["EUR", "GBP", "usd"])("refuses %s, naming the two it takes", (currency) => {
      const result = invoiceInputSchema.safeParse({ ...base, currency });
      expect(result.success).toBe(false);
      if (!result.success) expect(firstZodMessage(result.error)).toContain("USDC or EURC");
    });

    it("says nothing about USDC when an amount cannot be read", () => {
      const result = invoiceInputSchema.safeParse({ ...base, amount: "ten", currency: "EURC" });
      expect(result.success).toBe(false);
      if (!result.success) expect(firstZodMessage(result.error)).toContain("Use a positive amount with at most 6 decimal places");
    });
  });

  it.each(["2026-02-30", "2026-13-01", "31-10-2026", ""])("rejects invalid due date %s", (dueDate) => {
    expect(invoiceInputSchema.safeParse({ ...base, dueDate }).success).toBe(false);
  });

  describe("early-payment discount", () => {
    it("leaves both fields null when neither is entered", () => {
      const result = invoiceInputSchema.safeParse(base);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toMatchObject({ earlyPayDiscountPct: null, discountDeadline: null });
    });

    it("accepts a percent and a deadline on or before the due date", () => {
      const result = invoiceInputSchema.safeParse({ ...base, earlyPayDiscountPct: "2", discountDeadline: "2026-10-31" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toMatchObject({ earlyPayDiscountPct: "2", discountDeadline: "2026-10-31" });
    });

    it("refuses a percent without a deadline, on the deadline field, so the discount is never dropped", () => {
      // 2026-10-02, testnet-2: a payable entered with 2% and no deadline was added without its discount.
      const result = invoiceInputSchema.safeParse({ ...base, earlyPayDiscountPct: "2", discountDeadline: "" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(firstZodMessage(result.error)).toBe("discountDeadline: Enter the last day the discount applies, on or before the due date, or clear the discount.");
      }
    });

    it("refuses a deadline without a percent, on the percent field", () => {
      const result = invoiceInputSchema.safeParse({ ...base, earlyPayDiscountPct: "", discountDeadline: "2026-10-10" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(firstZodMessage(result.error)).toBe("earlyPayDiscountPct: Enter the discount percent, or clear the discount deadline.");
      }
    });

    it("names both fields when a malformed percent comes without a deadline", () => {
      const result = invoiceInputSchema.safeParse({ ...base, earlyPayDiscountPct: "abc", discountDeadline: "" });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(["earlyPayDiscountPct", "discountDeadline"]);
    });

    it("turns a refusal into a message naming the field's label, and an error for that field alone", () => {
      const result = invoiceInputSchema.safeParse({ ...base, earlyPayDiscountPct: "2", discountDeadline: "" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(invoiceFormRefusal(result.error)).toEqual({
          message: "Discount deadline: Enter the last day the discount applies, on or before the due date, or clear the discount.",
          fieldErrors: { discountDeadline: "Enter the last day the discount applies, on or before the due date, or clear the discount." },
        });
      }
    });

    it("keeps only the first error for a field that has several", () => {
      const result = invoiceInputSchema.safeParse({ ...base, amount: "-1", earlyPayDiscountPct: "abc", discountDeadline: "" });
      expect(result.success).toBe(false);
      if (!result.success) {
        const refusal = invoiceFormRefusal(result.error);
        expect(Object.keys(refusal.fieldErrors).sort()).toEqual(["amount", "discountDeadline", "earlyPayDiscountPct"]);
        expect(refusal.message.startsWith("Amount: ")).toBe(true);
      }
    });

    it.each(["0", "100", "100.00", "12.345", "abc", "-5", "0.001"])("rejects an out-of-range or malformed percent %s", (earlyPayDiscountPct) => {
      const result = invoiceInputSchema.safeParse({ ...base, earlyPayDiscountPct, discountDeadline: "2026-10-10" });
      expect(result.success).toBe(false);
    });

    it.each(["2", "2.5", "99.99", "0.5"])("accepts a well-formed percent %s", (earlyPayDiscountPct) => {
      const result = invoiceInputSchema.safeParse({ ...base, earlyPayDiscountPct, discountDeadline: "2026-10-10" });
      expect(result.success).toBe(true);
    });

    it("rejects a deadline after the due date", () => {
      const result = invoiceInputSchema.safeParse({ ...base, earlyPayDiscountPct: "2", discountDeadline: "2026-11-01" });
      expect(result.success).toBe(false);
      if (!result.success) expect(firstZodMessage(result.error)).toBe("discountDeadline: The discount deadline must be on or before the due date.");
    });

    it("accepts a deadline equal to the due date", () => {
      const result = invoiceInputSchema.safeParse({ ...base, earlyPayDiscountPct: "2", discountDeadline: "2026-10-31" });
      expect(result.success).toBe(true);
    });

    it("rejects an unparseable deadline", () => {
      const result = invoiceInputSchema.safeParse({ ...base, earlyPayDiscountPct: "2", discountDeadline: "not-a-date" });
      expect(result.success).toBe(false);
    });
  });
});
