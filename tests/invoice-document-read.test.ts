import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentReadError, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_CHARS, readDocument } from "@/lib/invoice-document/read";

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(__dirname, "fixtures", "invoice-document", name)));
const utf8 = (text: string) => new TextEncoder().encode(text);

async function failure(promise: Promise<unknown>): Promise<DocumentReadError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DocumentReadError) return error;
    throw error;
  }
  throw new Error("expected a DocumentReadError");
}

describe("reading an invoice document", () => {
  it("reads a PDF's text layer", async () => {
    const read = await readDocument({ bytes: fixture("northwind-inv-2207.pdf"), name: "northwind-inv-2207.pdf", type: "application/pdf" });
    expect(read.kind).toBe("pdf");
    expect(read.text).toContain("INV-2207");
    expect(read.text).toContain("PO-1042");
    expect(read.text).toContain("200.00");
    expect(read.text).toContain("0x5aF3107A4000000000000000000000000000b0b0");
    expect(read.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(read.truncated).toBe(false);
  });

  it("refuses a PDF with no text to read, as a scan", async () => {
    const error = await failure(readDocument({ bytes: fixture("scan.pdf"), name: "scan.pdf", type: "application/pdf" }));
    expect(error.code).toBe("scan");
    expect(error.message).toBe("This PDF has no text to read; it may be a scan. Paste the invoice's text instead.");
  });

  it("reads a text file or an email as UTF-8", async () => {
    const text = await readDocument({ bytes: utf8("Invoice INV-9\nTotal due 12.50 USDC"), name: "invoice.eml", type: "message/rfc822" });
    expect(text).toMatchObject({ kind: "email", text: "Invoice INV-9\nTotal due 12.50 USDC" });
    const plain = await readDocument({ bytes: utf8("Invoice INV-9 total 12.50"), name: "invoice.txt", type: "" });
    expect(plain.kind).toBe("text");
  });

  it("reads pasted text, with runs of spaces collapsed", async () => {
    const read = await readDocument({ text: "  Invoice   INV-9 \n\n\n Total   due 12.50  " });
    expect(read).toMatchObject({ kind: "text", text: "Invoice INV-9\n\nTotal due 12.50" });
    expect(read.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("caps the text the model will see", async () => {
    const read = await readDocument({ text: `Invoice total 10.00 ${"x".repeat(MAX_DOCUMENT_CHARS + 1000)}` });
    expect(read.text).toHaveLength(MAX_DOCUMENT_CHARS);
    expect(read.truncated).toBe(true);
  });

  it("refuses a file over the size limit before reading it", async () => {
    const error = await failure(readDocument({ bytes: new Uint8Array(MAX_DOCUMENT_BYTES + 1), name: "big.pdf", type: "application/pdf" }));
    expect(error.code).toBe("too_large");
  });

  it("refuses other kinds of file, and a .pdf name without a PDF inside", async () => {
    expect((await failure(readDocument({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), name: "invoice.png", type: "image/png" }))).code).toBe("unsupported");
    expect((await failure(readDocument({ bytes: utf8("not a pdf"), name: "invoice.pdf", type: "application/pdf" }))).code).toBe("unsupported");
  });

  it("refuses an empty document", async () => {
    expect((await failure(readDocument({ text: "   " }))).code).toBe("empty");
    expect((await failure(readDocument({ bytes: new Uint8Array(0), name: "empty.txt", type: "text/plain" }))).code).toBe("empty");
  });
});
