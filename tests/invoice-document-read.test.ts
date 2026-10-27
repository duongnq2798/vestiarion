import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentReadError, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_CHARS, readDocument } from "@/lib/invoice-document/read";
import { inflateBombPdf, INVOICE_LINE, lzwLiterals, nestedFormsPdf, onePagePdf, pagesPdf, streamObject, withUnmeasuredStream } from "./support/pdf-files";

/**
 * Reading an invoice document (invoice from a document D1, D2), with the real reader: a PDF's text layer, a scan, a
 * text file, an email, pasted text and the limits. A PDF the pre-scan measures past 16 MB decoded is refused before
 * pdf.js reads it (document checks DK3); one it cannot measure is read in the worker, within its limits
 * (docs/superpowers/specs/2026-10-27-request-pdf-bound-design.md RB2).
 */

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

  it("refuses a PDF of under a megabyte that would decode to 600 MB before pdf.js reads it, and reads an email's text beside one", async () => {
    // Without the pre-scan, pdf.js would parse it on this thread, decoding every megabyte.
    const bomb = inflateBombPdf(600);
    const started = Date.now();
    const error = await failure(readDocument({ bytes: bomb, name: "invoice.pdf", type: "application/pdf" }));
    expect(error.code).toBe("unsupported");
    expect(error.message).toBe("This PDF could not be read. Paste the invoice's text instead.");
    expect(Date.now() - started).toBeLessThan(5_000);
    const email = [
      "Subject: Invoice INV-2207",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "Total due 200.00 USDC",
      "--b",
      'Content-Type: application/pdf; name="INV-2207.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="INV-2207.pdf"',
      "",
      Buffer.from(bomb).toString("base64"),
      "--b--",
      "",
    ].join("\r\n");
    const read = await readDocument({ bytes: utf8(email), name: "invoice.eml", type: "message/rfc822" });
    expect(read.text).toContain("Total due 200.00 USDC");
  });

  it("reads a PDF the pre-scan cannot measure in the worker, to the text of the same page unencoded (RB2)", async () => {
    const plain = await readDocument({ bytes: onePagePdf(streamObject("", INVOICE_LINE)), name: "invoice.pdf", type: "application/pdf" });
    // LZW, which the pre-scan cannot measure; and an /Encrypt key on a stream's dictionary, which pdf.js ignores.
    for (const contents of [streamObject("/Filter /LZWDecode", lzwLiterals(INVOICE_LINE)), streamObject("/Encrypt 1", INVOICE_LINE)]) {
      const read = await readDocument({ bytes: onePagePdf(contents), name: "invoice.pdf", type: "application/pdf" });
      expect(read).toMatchObject({ kind: "pdf", text: plain.text, truncated: false });
    }
  }, 30_000);

  it("refuses a PDF the pre-scan cannot measure of more than 50 pages (RB2)", async () => {
    const error = await failure(readDocument({ bytes: withUnmeasuredStream(pagesPdf(51)), name: "invoice.pdf", type: "application/pdf" }));
    expect(error.code).toBe("unsupported");
    expect(error.message).toBe("This PDF could not be read. Paste the invoice's text instead.");
  }, 30_000);

  it("stops a PDF the pre-scan cannot measure at 15 s when it keeps pdf.js busy, and the thread that asked keeps running (RB2)", async () => {
    // About 95 s on the thread that parses it, with unpdf 1.8.1.
    const bytes = withUnmeasuredStream(nestedFormsPdf({ fanOut: 10, depth: 6 }));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 25);
    const started = Date.now();
    try {
      const error = await failure(readDocument({ bytes, name: "invoice.pdf", type: "application/pdf" }));
      expect(error.code).toBe("unsupported");
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - started).toBeLessThan(40_000);
    expect(ticks).toBeGreaterThan(100);
  }, 60_000);
});
