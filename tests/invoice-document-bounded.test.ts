import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PDF_LIMITS, pdfPagesInWorker, PdfWorkerRefusal } from "@/lib/invoice-document/pdf-worker";
import { DocumentReadError, MAX_DOCUMENT_CHARS, readDocument, readPdfBounded, type ReadDocument } from "@/lib/invoice-document/read";
import { deflatedWithSpaces, inflateBombPdf, INVOICE_LINE, nestedFormsPdf, onePagePdf, pagesPdf, streamObject } from "./support/pdf-files";

/**
 * The bounded PDF reader the cycle reads a vendor's document with (docs/superpowers/specs/2026-10-25-exception-
 * resolution-part-2-design.md DK3): the same text `readDocument` gives, read in a worker thread with its own heap, a
 * budget for the whole process's memory and a time limit, after a pre-scan that refuses a file whose streams would
 * decode to more than 16 MB. So a PDF built to make pdf.js work forever, or to fill its memory, stops in its own thread
 * and is unreadable, while the thread that asked keeps running. A stop that may not be the file's doing (the process's
 * memory, or a timeout while another PDF was parsed on this thread) says to try again; a reader that cannot start
 * throws a plain Error: neither is the file's doing for certain.
 */

const MB = 2 ** 20;

/** What `run` settles to, and the process's peak RSS above its start meanwhile, sampled every 10 ms, in MB. */
async function withPeakGrowth(run: () => Promise<unknown>): Promise<{ settled: unknown; peakMb: number }> {
  const start = process.memoryUsage.rss();
  let peak = start;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 10);
  try {
    const settled = await run().catch((error: unknown) => error);
    peak = Math.max(peak, process.memoryUsage.rss());
    return { settled, peakMb: (peak - start) / MB };
  } finally {
    clearInterval(timer);
  }
}

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
    // A slow runner can take longer than the default 15 s to fill even a small heap, so the memory case gets a long
    // timeout: the heap limit, not the clock, must be what stops it.
    const small = { ...PDF_LIMITS, timeoutMs: 90_000, maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 4, maxChars: MAX_DOCUMENT_CHARS };
    const full = await pdfPagesInWorker(nestedFormsPdf({ fanOut: 10, depth: 6 }), small).catch((error: unknown) => error);
    expect(full).toBeInstanceOf(PdfWorkerRefusal);
    // Its own heap filled: the file's doing, whatever else ran.
    expect(full).toMatchObject({ why: "memory", retry: false });
    const slow = await pdfPagesInWorker(nestedFormsPdf({ fanOut: 10, depth: 6 }), { ...PDF_LIMITS, timeoutMs: 500, maxChars: MAX_DOCUMENT_CHARS }).catch((error: unknown) => error);
    // Nothing else was parsed meanwhile: the time it took is the file's own.
    expect(slow).toMatchObject({ why: "timeout", retry: false });
    const refused = await readPdfBounded(nestedFormsPdf({ fanOut: 10, depth: 6 }), { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 4 }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DocumentReadError);
  }, 180_000);

  it("refuses a PDF of more pages than its limit, 50 by default, and reads one at it", async () => {
    expect(PDF_LIMITS).toEqual({ timeoutMs: 15_000, maxPages: 50, maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, maxRssGrowthMb: 512 });
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

  it("refuses a PDF of under a megabyte that would decode to 600 MB before any worker parses it", async () => {
    const bomb = inflateBombPdf(600);
    expect(bomb.byteLength).toBeLessThan(MB);
    const started = Date.now();
    const { settled, peakMb } = await withPeakGrowth(() => readPdfBounded(bomb));
    expect(settled).toBeInstanceOf(DocumentReadError);
    expect((settled as DocumentReadError).code).toBe("unsupported");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(peakMb).toBeLessThan(128);
  });

  it("stops a worker once the process's memory grows past its budget, which the heap limit never counts, and says to try again", async () => {
    // pdf.js decodes a stream into an ArrayBuffer, outside the worker's heap: 300 MB here, from about 300 KB. Read in
    // the worker directly, past the pre-scan, so the budget is what stops it.
    const bomb = inflateBombPdf(300);
    const limits = { ...PDF_LIMITS, timeoutMs: 90_000, maxRssGrowthMb: 128, maxChars: MAX_DOCUMENT_CHARS };
    const { settled, peakMb } = await withPeakGrowth(() => pdfPagesInWorker(bomb, limits));
    expect(settled).toBeInstanceOf(PdfWorkerRefusal);
    // The process's memory counts every thread's, so the stop may not be the file's doing: it is tried again.
    expect(settled).toMatchObject({ why: "memory", retry: true });
    expect(peakMb).toBeLessThan(128 + 256);
  }, 120_000);

  it("says to try again after a timeout while a PDF was parsed on this thread, and readPdfBounded passes that on", async () => {
    const limits = { ...PDF_LIMITS, timeoutMs: 1_000, maxChars: MAX_DOCUMENT_CHARS };
    const contended = pdfPagesInWorker(nestedFormsPdf({ fanOut: 10, depth: 6 }), limits).catch((error: unknown) => error);
    // readDocument parses on the thread that asked, beside the worker.
    await readDocument({ bytes: fixture("northwind-inv-2207.pdf"), name: "document.pdf", type: "application/pdf" });
    expect(await contended).toMatchObject({ why: "timeout", retry: true });
    const bounded = readPdfBounded(nestedFormsPdf({ fanOut: 10, depth: 6 }), { timeoutMs: 1_000 }).catch((error: unknown) => error);
    await readDocument({ bytes: fixture("northwind-inv-2207.pdf"), name: "document.pdf", type: "application/pdf" });
    const passed = await bounded;
    expect(passed).toBeInstanceOf(PdfWorkerRefusal);
    expect(passed).not.toBeInstanceOf(DocumentReadError);
  }, 30_000);

  it("reads the text of a page that draws a large image, which pdf.js never decodes to read text", async () => {
    const image = streamObject(
      "/Type /XObject /Subtype /Image /Width 4096 /Height 4096 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode",
      deflatedWithSpaces("", 48)
    );
    const pdf = onePagePdf(streamObject("", `q 100 0 0 100 36 600 cm /Im1 Do Q ${INVOICE_LINE}`), { more: [image], resources: "/XObject << /Im1 6 0 R >>" });
    const read = (await readPdfBounded(pdf)) as ReadDocument;
    expect(read.text).toContain("INV-2207");
  });

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
