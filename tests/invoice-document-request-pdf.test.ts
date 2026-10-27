import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where a PDF someone sends in is read (docs/superpowers/specs/2026-10-27-request-pdf-bound-design.md RB1-RB6), with
 * the worker and pdf.js on this thread watched. The strict pre-scan decides: a file it measures past 16 MB decoded is
 * refused, even beside streams it skips (RB6); one it measured is parsed on this thread, as before; one it cannot
 * measure (LZW, run-length or Brotli where text is read, encryption, more streams than it takes on) is read in the
 * worker under the request's limits, never by pdf.js on this thread, never behind the cycle's queue. A stop that is the
 * file's reads as one that could not be read; a timeout beside other reads says to try again; a reader that could not
 * start is thrown as it is. An email's PDFs are read one at a time, the first three, and an email with PDFs attached is
 * never read as its MIME, even when nothing in it has text (RB5).
 */

const { workerSpy, proxySpy, actualWorker } = vi.hoisted(() => ({
  workerSpy: vi.fn(),
  proxySpy: vi.fn(),
  actualWorker: { read: null as null | typeof import("@/lib/invoice-document/pdf-worker").pdfPagesInWorker },
}));
// The real worker, watched: a test may answer in its place.
vi.mock("@/lib/invoice-document/pdf-worker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/invoice-document/pdf-worker")>();
  actualWorker.read = actual.pdfPagesInWorker;
  return {
    ...actual,
    pdfPagesInWorker: (...args: Parameters<typeof actual.pdfPagesInWorker>) =>
      (workerSpy(...args) as ReturnType<typeof actual.pdfPagesInWorker> | undefined) ?? actual.pdfPagesInWorker(...args),
  };
});
// pdf.js on this thread, watched.
vi.mock("unpdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("unpdf")>();
  return {
    ...actual,
    getDocumentProxy: (...args: Parameters<typeof actual.getDocumentProxy>) => {
      proxySpy();
      return actual.getDocumentProxy(...args);
    },
  };
});

import { prescanPdf } from "@/lib/invoice-document/pdf-prescan";
import { oneParseAtATime, PDF_LIMITS, PdfWorkerRefusal, REQUEST_PDF_LIMITS } from "@/lib/invoice-document/pdf-worker";
import { DocumentReadError, MAX_DOCUMENT_CHARS, readDocument } from "@/lib/invoice-document/read";
import { inflateBombPdf, INVOICE_LINE, lzwBeforeBombPdf, lzwLiterals, nestedFormsPdf, onePagePdf, streamObject, withUnmeasuredStream } from "./support/pdf-files";

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(process.cwd(), "tests", "fixtures", "invoice-document", name)));
const pdf = (bytes: Uint8Array) => ({ bytes, name: "invoice.pdf", type: "application/pdf" });
const answer = (...pages: string[]) => Promise.resolve({ pages, cut: false });
const latin1 = (text: string) => Buffer.from(text, "latin1");
const UNREADABLE = "This PDF could not be read. Paste the invoice's text instead.";
const EMAIL_PDFS_UNREAD =
  "There is no text to read in the email or the first three PDFs attached to it, and the PDFs after those were not read. Choose the invoice's PDF on its own, or paste its text.";
/** The invoice's line of text, as pdf.js reads it. */
const READ_LINE = "Northwind Hosting invoice INV-2207, total due 200.00 USDC, purchase order PO-1042";
/** One page whose text is LZW-encoded: the pre-scan cannot measure it, pdf.js reads it. */
const LZW_PAGE = onePagePdf(streamObject("/Filter /LZWDecode", lzwLiterals(INVOICE_LINE)));

/** An email of `text` with `pdfs` attached, as an `.eml` file. */
function email(text: string, pdfs: Uint8Array[]): Uint8Array {
  const lines = ["Subject: Invoice INV-2207", 'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain", "", text];
  pdfs.forEach((bytes, index) => {
    const name = `part-${index + 1}.pdf`;
    lines.push("--b", `Content-Type: application/pdf; name="${name}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${name}"`, "", Buffer.from(bytes).toString("base64"));
  });
  lines.push("--b--", "");
  return new TextEncoder().encode(lines.join("\r\n"));
}

/**
 * An email with only `pdfs` attached, as a scanner sends one: no text of its own, and no subject, or (`subject: ""`) an
 * empty one.
 */
function bareEmail(pdfs: Uint8Array[], { subject }: { subject?: string } = {}): Uint8Array {
  const lines = [...(subject === undefined ? [] : [`Subject: ${subject}`]), 'Content-Type: multipart/mixed; boundary="b"', ""];
  pdfs.forEach((bytes, index) => {
    const name = `scan-${index + 1}.pdf`;
    lines.push("--b", `Content-Type: application/pdf; name="${name}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${name}"`, "", Buffer.from(bytes).toString("base64"));
  });
  lines.push("--b--", "");
  return new TextEncoder().encode(lines.join("\r\n"));
}

const eml = (bytes: Uint8Array) => ({ bytes, name: "invoice.eml", type: "message/rfc822" });
/** A page with no text: a scan, as pdf.js reads one on this thread. */
const BLANK_PAGE = onePagePdf(streamObject("", "q Q\n"));
/** The invoice's page, measured, so pdf.js reads it on this thread. */
const INVOICE_PAGE = onePagePdf(streamObject("", INVOICE_LINE));

beforeEach(() => {
  workerSpy.mockReset();
  proxySpy.mockReset();
});

describe("where a PDF someone sends in is read (RB1, RB2)", () => {
  it("parses a PDF the pre-scan measured on this thread, as before, with no worker", async () => {
    const read = await readDocument(pdf(fixture("northwind-inv-2207.pdf")));
    expect(read.text).toContain("INV-2207");
    expect(proxySpy).toHaveBeenCalledTimes(1);
    expect(workerSpy).not.toHaveBeenCalled();
  });

  it("reads one whose text is LZW-encoded in the worker, under the request's limits, to the text of the same page unencoded", async () => {
    expect(REQUEST_PDF_LIMITS).toEqual({ ...PDF_LIMITS, maxRssGrowthMb: 256 });
    expect(REQUEST_PDF_LIMITS).toEqual({ timeoutMs: 15_000, maxPages: 50, maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, maxRssGrowthMb: 256 });
    expect(prescanPdf(LZW_PAGE).refused).toBe("unbounded_filter");
    const plain = await readDocument(pdf(onePagePdf(streamObject("", INVOICE_LINE))));
    expect(plain.text).toBe(READ_LINE);
    proxySpy.mockReset();
    const read = await readDocument(pdf(LZW_PAGE));
    expect(workerSpy).toHaveBeenCalledTimes(1);
    expect(workerSpy).toHaveBeenCalledWith(LZW_PAGE, { ...REQUEST_PDF_LIMITS, maxChars: MAX_DOCUMENT_CHARS });
    expect(proxySpy).not.toHaveBeenCalled();
    expect(read).toMatchObject({ kind: "pdf", text: plain.text, truncated: false });
  }, 30_000);

  it("sends every other file the pre-scan cannot measure to the worker, never to pdf.js on this thread", async () => {
    const page = streamObject("", INVOICE_LINE);
    for (const [label, bytes, why] of [
      ["run-length", onePagePdf(streamObject("/Filter /RunLengthDecode", "anything")), "unbounded_filter"],
      ["Brotli", onePagePdf(streamObject("/Filter /BrotliDecode", "anything")), "unbounded_filter"],
      ["Flate before LZW", onePagePdf(streamObject("/Filter [/FlateDecode /LZWDecode]", "anything")), "unbounded_filter"],
      ["an LZW stream no page draws", withUnmeasuredStream(onePagePdf(page)), "unbounded_filter"],
      ["an LZW stream before one measured under the budget", lzwBeforeBombPdf(1), "unbounded_filter"],
      ["encrypted", onePagePdf(page, { more: ["<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>"], trailer: "/Encrypt 6 0 R " }), "encrypted"],
      ["/Encrypt on a stream's dictionary", onePagePdf(streamObject("/Encrypt 1", INVOICE_LINE)), "encrypted"],
      ["more than 10,000 streams", onePagePdf(page, { more: Array.from({ length: 10_001 }, () => streamObject("", "q Q")) }), "too_complex"],
    ] as const) {
      expect(prescanPdf(bytes).refused, label).toBe(why);
      workerSpy.mockReset();
      workerSpy.mockReturnValueOnce(answer(READ_LINE));
      const read = await readDocument(pdf(bytes));
      expect(read.text, label).toBe(READ_LINE);
      expect(workerSpy, label).toHaveBeenCalledTimes(1);
      expect(proxySpy, label).not.toHaveBeenCalled();
    }
  });

  it("still refuses a file it measures past 16 MB decoded, with neither the worker nor pdf.js, beside streams it cannot measure", async () => {
    const bomb = inflateBombPdf(600);
    for (const [label, bytes] of [
      ["a 600 MB bomb", bomb],
      ["an LZW stream before a 600 MB bomb", lzwBeforeBombPdf(600)],
      ["a fake trailer in a comment beside a 600 MB bomb", new Uint8Array(Buffer.concat([bomb, latin1("% trailer << /Encrypt 1 0 R >>\n")]))],
    ] as const) {
      expect(prescanPdf(bytes).refused, label).toBe("decoded_limit");
      const error = await readDocument(pdf(bytes)).catch((caught: unknown) => caught);
      expect(error, label).toBeInstanceOf(DocumentReadError);
      expect(error, label).toMatchObject({ code: "unsupported", message: UNREADABLE });
      expect(workerSpy, label).not.toHaveBeenCalled();
      expect(proxySpy, label).not.toHaveBeenCalled();
    }
  });

  it("signs the read truncated when the worker left pages unread past 20,000 characters", async () => {
    workerSpy.mockReturnValueOnce(Promise.resolve({ pages: [READ_LINE, READ_LINE], cut: true }));
    expect(await readDocument(pdf(LZW_PAGE))).toMatchObject({ kind: "pdf", truncated: true });
  });

  it("never waits for a turn of the cycle's queue", async () => {
    let release = () => {};
    const held = oneParseAtATime(() => new Promise<void>((resolve) => (release = resolve)));
    try {
      workerSpy.mockReturnValueOnce(answer(READ_LINE));
      await expect(readDocument(pdf(LZW_PAGE))).resolves.toMatchObject({ text: READ_LINE });
    } finally {
      release();
      await held;
    }
  });

  it("is not counted as a parse on this thread: the worker's own timeout, with nothing else read, is the file's", async () => {
    // The real worker, on a PDF that keeps pdf.js busy, with a short clock: counted as a parse here, its own timeout
    // would read as another read's, and say to try again.
    workerSpy.mockImplementationOnce((_bytes: Uint8Array, limits: typeof REQUEST_PDF_LIMITS & { maxChars: number }) =>
      actualWorker.read!(nestedFormsPdf({ fanOut: 10, depth: 6 }), { ...limits, timeoutMs: 1_000 })
    );
    const error = await readDocument(pdf(LZW_PAGE)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DocumentReadError);
    expect(error).toMatchObject({ code: "unsupported", message: UNREADABLE });
  }, 30_000);
});

describe("what a request's worker read says (RB3)", () => {
  it("reads as a PDF that could not be read when the worker stopped it for the file's doing, its memory included", async () => {
    for (const refusal of [
      new PdfWorkerRefusal("pages"),
      new PdfWorkerRefusal("timeout"),
      new PdfWorkerRefusal("memory"),
      new PdfWorkerRefusal("memory", { retry: true }),
      new PdfWorkerRefusal("parse"),
      new PdfWorkerRefusal("stopped"),
    ]) {
      workerSpy.mockReturnValueOnce(Promise.reject(refusal));
      const error = await readDocument(pdf(LZW_PAGE)).catch((caught: unknown) => caught);
      expect(error, `${refusal.why} ${refusal.retry}`).toBeInstanceOf(DocumentReadError);
      expect(error, `${refusal.why} ${refusal.retry}`).toMatchObject({ code: "unsupported", message: UNREADABLE });
    }
  });

  it("says to try again, with a plain Error, after a timeout while other PDFs were read in this process", async () => {
    workerSpy.mockReturnValueOnce(Promise.reject(new PdfWorkerRefusal("timeout", { retry: true })));
    const error = await readDocument(pdf(LZW_PAGE)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DocumentReadError);
    expect(error).not.toBeInstanceOf(PdfWorkerRefusal);
    expect((error as Error).message).toMatch(/try again/);
  });

  it("throws a reader that could not start as it is", async () => {
    const failed = new Error("the PDF reader could not start: unpdf could not be loaded");
    workerSpy.mockReturnValueOnce(Promise.reject(failed));
    expect(await readDocument(pdf(LZW_PAGE)).catch((caught: unknown) => caught)).toBe(failed);
  });
});

describe("an email's PDFs (RB5)", () => {
  it("reads the first three PDFs attached, one after another", async () => {
    let running = 0;
    let most = 0;
    let answered = 0;
    workerSpy.mockImplementation(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
      answered++;
      return { pages: [`Attachment ${answered} of five, total due 10.00 USDC`], cut: false };
    });
    const read = await readDocument(eml(email("Five invoices attached.", [LZW_PAGE, LZW_PAGE, LZW_PAGE, LZW_PAGE, LZW_PAGE])));
    expect(workerSpy).toHaveBeenCalledTimes(3);
    expect(most).toBe(1);
    expect(read.text).toContain("Five invoices attached.");
    for (const n of [1, 2, 3]) expect(read.text).toContain(`Attachment ${n} of five`);
    expect(read.text).not.toContain("Attachment 4 of five");
    // The ones left out are said, for the draft to warn of; not as a cut, which is about characters.
    expect(read).toMatchObject({ kind: "email", pdfsLeftOut: true, truncated: false });
  });

  it("says nothing was left out of an email with three PDFs or fewer", async () => {
    workerSpy.mockImplementation(() => answer(READ_LINE));
    for (const count of [0, 1, 3]) {
      const read = await readDocument(eml(email("Total due 200.00 USDC", Array.from({ length: count }, () => LZW_PAGE))));
      expect(read.pdfsLeftOut, String(count)).toBeUndefined();
    }
    expect((await readDocument(pdf(LZW_PAGE))).pdfsLeftOut).toBeUndefined();
  });

  it("leaves out a PDF that could not be read, and fails the read when its reader may be stopped for no fault of the file", async () => {
    workerSpy.mockReturnValueOnce(Promise.reject(new PdfWorkerRefusal("pages")));
    const read = await readDocument(eml(email("Total due 200.00 USDC", [LZW_PAGE])));
    expect(read.text).toContain("Total due 200.00 USDC");
    workerSpy.mockReturnValueOnce(Promise.reject(new PdfWorkerRefusal("timeout", { retry: true })));
    const error = await readDocument(eml(email("Total due 200.00 USDC", [LZW_PAGE]))).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DocumentReadError);
  });

  it("signs the email truncated when an attachment's pages were left unread", async () => {
    workerSpy.mockReturnValueOnce(Promise.resolve({ pages: [READ_LINE], cut: true }));
    expect(await readDocument(eml(email("Total due 200.00 USDC", [LZW_PAGE])))).toMatchObject({ kind: "email", truncated: true });
  });

  it("never reads an email with PDFs attached as its MIME, and says the PDFs after the third were not read when nothing before them had text", async () => {
    // A scanner's email: no subject, no text, three scans and then the invoice, which is never read.
    for (const subject of [undefined, ""]) {
      proxySpy.mockReset();
      const error = await readDocument(eml(bareEmail([BLANK_PAGE, BLANK_PAGE, BLANK_PAGE, INVOICE_PAGE], { subject }))).catch((caught: unknown) => caught);
      expect(error, String(subject)).toBeInstanceOf(DocumentReadError);
      expect(error, String(subject)).toMatchObject({ code: "empty", message: EMAIL_PDFS_UNREAD });
      expect(proxySpy, String(subject)).toHaveBeenCalledTimes(3);
    }
    // With no PDF left out, it has no text to read, as any document with none; never its headers and base64.
    const error = await readDocument(eml(bareEmail([BLANK_PAGE]))).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DocumentReadError);
    expect(error).toMatchObject({ code: "empty", message: "There is no text to read. Choose a file or paste the invoice's text." });
  });

  it("still says the PDFs after the third were left out when a subject is all the email's own text", async () => {
    const read = await readDocument(eml(bareEmail([BLANK_PAGE, BLANK_PAGE, BLANK_PAGE, INVOICE_PAGE], { subject: "Scan" })));
    expect(read).toMatchObject({ kind: "email", text: "Subject: Scan", pdfsLeftOut: true });
  });
});
