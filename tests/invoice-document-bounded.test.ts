import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PDF_LIMITS, pdfPagesInWorker, PdfWorkerRefusal } from "@/lib/invoice-document/pdf-worker";
import { DocumentReadError, MAX_DOCUMENT_CHARS, readDocument, readPdfBounded } from "@/lib/invoice-document/read";
import { nestedFormsPdf, pagesPdf } from "./support/pdf-files";

/**
 * The bounded PDF reader the cycle reads a vendor's document with (docs/superpowers/specs/2026-10-25-exception-
 * resolution-part-2-design.md DK3): the same text `readDocument` gives, read in a worker thread with its own heap and a
 * time limit, so a PDF built to make pdf.js work forever, or to fill its memory, stops in its own thread and is
 * unreadable, while the thread that asked keeps running. A reader that cannot start throws instead: that is not the
 * file's doing.
 */

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(process.cwd(), "tests", "fixtures", "invoice-document", name)));

describe("readPdfBounded", () => {
  it("reads a PDF to the same text, hash and cut that readDocument gives it", async () => {
    for (const bytes of [fixture("northwind-inv-2207.pdf"), pagesPdf(3)]) {
      const bounded = await readPdfBounded(bytes);
      expect(bounded).toEqual(await readDocument({ bytes, name: "document.pdf", type: "application/pdf" }));
    }
  });

  it("keeps the bytes it was given, whole", async () => {
    const bytes = fixture("northwind-inv-2207.pdf");
    const before = Buffer.from(bytes).toString("hex");
    await readPdfBounded(bytes);
    expect(Buffer.from(bytes).toString("hex")).toBe(before);
  });

  it("refuses a scan, an empty file, one over 4 MB and one that is no PDF, as readDocument does", async () => {
    await expect(readPdfBounded(fixture("scan.pdf"))).rejects.toMatchObject({ code: "scan" });
    await expect(readPdfBounded(new Uint8Array())).rejects.toMatchObject({ code: "empty" });
    await expect(readPdfBounded(new Uint8Array(4_000_001))).rejects.toMatchObject({ code: "too_large" });
    await expect(readPdfBounded(new TextEncoder().encode("<html>Total due 200.00 USDC</html>"))).rejects.toMatchObject({ code: "unsupported" });
  });

  it("stops a PDF of nested forms at its time limit, and the thread that asked keeps running meanwhile", async () => {
    // About 95 s unbounded on unpdf 1.8.1, holding the thread that parses it the whole time.
    const bytes = nestedFormsPdf({ fanOut: 10, depth: 6 });
    expect(bytes.byteLength).toBeLessThan(4_000);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 25);
    const started = Date.now();
    try {
      const refused = await readPdfBounded(bytes, { timeoutMs: 1_000 }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(DocumentReadError);
      expect((refused as DocumentReadError).code).toBe("unsupported");
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(ticks).toBeGreaterThan(10);
  }, 20_000);

  it("stops a worker that fills its heap, as unreadable, and says which limit stopped it", async () => {
    const small = { ...PDF_LIMITS, maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 4, maxChars: MAX_DOCUMENT_CHARS };
    const full = await pdfPagesInWorker(nestedFormsPdf({ fanOut: 10, depth: 6 }), small).catch((error: unknown) => error);
    expect(full).toBeInstanceOf(PdfWorkerRefusal);
    expect((full as PdfWorkerRefusal).why).toBe("memory");
    const slow = await pdfPagesInWorker(nestedFormsPdf({ fanOut: 10, depth: 6 }), { ...PDF_LIMITS, timeoutMs: 500, maxChars: MAX_DOCUMENT_CHARS }).catch((error: unknown) => error);
    expect((slow as PdfWorkerRefusal).why).toBe("timeout");
    const refused = await readPdfBounded(nestedFormsPdf({ fanOut: 10, depth: 6 }), { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 4 }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DocumentReadError);
  }, 60_000);

  it("refuses a PDF of more pages than its limit, 50 by default, and reads one at it", async () => {
    expect(PDF_LIMITS).toEqual({ timeoutMs: 15_000, maxPages: 50, maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 });
    await expect(readPdfBounded(pagesPdf(51))).rejects.toMatchObject({ code: "unsupported" });
    const fifty = await readPdfBounded(pagesPdf(50));
    expect(fifty.text).toContain("Page 50 of 50:");
    await expect(readPdfBounded(pagesPdf(4), { maxPages: 3 })).rejects.toMatchObject({ code: "unsupported" });
  }, 30_000);

  it("stops reading pages once the text passes 20,000 characters, and says it was cut", async () => {
    // About 30,000 characters over 48 pages: 10 lines of 58 on each.
    const read = await readPdfBounded(pagesPdf(48, "Managed hosting for the month, with support and backups.", 10));
    expect(read.truncated).toBe(true);
    expect(read.text.length).toBeLessThanOrEqual(MAX_DOCUMENT_CHARS);
    expect(read.text).toContain("Page 1 of 48:");
    expect(read.text).not.toContain("Page 48 of 48:");
  }, 30_000);

  it("throws, and does not call the file unreadable, when the reader cannot load", async () => {
    // The worker loads unpdf from the working directory's node_modules: from anywhere else it cannot.
    const bytes = fixture("northwind-inv-2207.pdf");
    const home = process.cwd();
    process.chdir(os.tmpdir());
    try {
      const failed = await readPdfBounded(bytes).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      expect(failed).not.toBeInstanceOf(DocumentReadError);
      expect((failed as Error).message).toMatch(/the PDF reader could not start/);
    } finally {
      process.chdir(home);
    }
  });
});
