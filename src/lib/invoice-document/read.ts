import { createHash } from "node:crypto";
import { extractText, getDocumentProxy } from "unpdf";
import { emailParts } from "./email";
import { prescanPdf } from "./pdf-prescan";
import { countedParse, PDF_LIMITS, pdfPagesInWorker, PdfWorkerRefusal, REQUEST_PDF_LIMITS, type PdfLimits } from "./pdf-worker";

/**
 * An invoice document to plain text, for the model to read (invoice from a
 * document D1, D2). A PDF is read from its text layer on the server, in a
 * worker when the pre-scan cannot measure it (request PDF bound RB1); a text
 * file, an email or pasted text is taken as it is. The document itself is
 * never stored: only its text is used, and its hash recorded.
 */

/** The largest file read, in bytes (D1). */
export const MAX_DOCUMENT_BYTES = 4_000_000;
/** The most text the model is shown (D2). */
export const MAX_DOCUMENT_CHARS = 20_000;
/** Fewer letters and digits than this in a PDF means there was no text layer to read: a scan (D2). */
const MIN_PDF_CHARACTERS = 40;

export type DocumentReadErrorCode = "too_large" | "unsupported" | "scan" | "empty";

const MESSAGES: Record<DocumentReadErrorCode, string> = {
  too_large: "Choose a file of at most 4 MB.",
  unsupported: "Choose a PDF, a .txt or an .eml file, or paste the invoice's text.",
  scan: "This PDF has no text to read; it may be a scan. Paste the invoice's text instead.",
  empty: "There is no text to read. Choose a file or paste the invoice's text.",
};

/** A refusal whose message is safe to show the person who sent the document. */
export class DocumentReadError extends Error {
  constructor(readonly code: DocumentReadErrorCode, message: string = MESSAGES[code]) {
    super(message);
    this.name = "DocumentReadError";
  }
}

export type DocumentInput = { bytes: Uint8Array; name: string; type: string } | { text: string };

export interface ReadDocument {
  kind: "pdf" | "email" | "text";
  text: string;
  /** The SHA-256 of the bytes read, or of the pasted text's UTF-8, in hex. */
  sha256: string;
  /** True when the text was cut to MAX_DOCUMENT_CHARS. */
  truncated: boolean;
  /** True when an email held more PDFs than the first three read (RB5), whose text it leaves out; absent otherwise. */
  pdfsLeftOut?: true;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Trims each line, collapses runs of spaces, and keeps at most one blank line between paragraphs. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function finish(kind: ReadDocument["kind"], text: string, hash: string): ReadDocument {
  const tidied = tidy(text);
  // A PDF with no text layer is a scan, however little text it has: say so, rather than "empty".
  if (kind === "pdf" && (tidied.match(/[A-Za-z0-9]/g)?.length ?? 0) < MIN_PDF_CHARACTERS) throw new DocumentReadError("scan");
  if (!/[A-Za-z0-9]/.test(tidied)) throw new DocumentReadError("empty");
  const truncated = tidied.length > MAX_DOCUMENT_CHARS;
  return { kind, text: truncated ? tidied.slice(0, MAX_DOCUMENT_CHARS) : tidied, sha256: hash, truncated };
}

/**
 * Text read from a file, whether pages of a PDF in it were left unread once the text passed MAX_DOCUMENT_CHARS, and,
 * for an email, whether PDFs attached past the first three were left out.
 */
interface TextRead {
  text: string;
  cut: boolean;
  pdfsLeftOut?: boolean;
}

/** `finish`, signed `truncated` too when pages were left unread, however short the text kept, and `pdfsLeftOut`. */
function finishRead(kind: ReadDocument["kind"], { text, cut, pdfsLeftOut }: TextRead, hash: string): ReadDocument {
  const finished = finish(kind, text, hash);
  const document = cut && !finished.truncated ? { ...finished, truncated: true } : finished;
  return pdfsLeftOut ? { ...document, pdfsLeftOut: true } : document;
}

function isPdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

function isEmail(name: string, type: string): boolean {
  return /\.eml$/i.test(name) || type === "message/rfc822";
}

function isText(name: string, type: string): boolean {
  return /\.txt$/i.test(name) || type.startsWith("text/");
}

/** What a PDF that could not be read says. */
const PDF_UNREADABLE = "This PDF could not be read. Paste the invoice's text instead.";

/**
 * A PDF someone sent in, to text (docs/superpowers/specs/2026-10-27-request-pdf-bound-design.md RB1). The pre-scan
 * first (./pdf-prescan.ts, document checks DK3): a file whose streams it measures past 16 MB decoded is refused, since
 * pdf.js would decode them outside any heap limit. One it measured is parsed on this thread, as before, counted for a
 * worker that times out meanwhile. One it cannot measure (encrypted; LZW, run-length, Brotli or an image codec where
 * text is read; more streams or work than it takes on) is read in a worker, within its limits (`unmeasuredPdfText`).
 */
async function pdfText(bytes: Uint8Array): Promise<TextRead> {
  const { refused } = prescanPdf(bytes);
  if (refused === "decoded_limit") throw new DocumentReadError("unsupported", PDF_UNREADABLE);
  if (refused) return unmeasuredPdfText(bytes);
  try {
    // unpdf takes ownership of the buffer it is given: hand it a copy, so the hash is of what was sent.
    const { text } = await countedParse(async () => extractText(await getDocumentProxy(bytes.slice()), { mergePages: true }));
    return { text, cut: false };
  } catch {
    throw new DocumentReadError("unsupported", PDF_UNREADABLE);
  }
}

/**
 * A PDF the pre-scan cannot measure, read in a worker under `REQUEST_PDF_LIMITS` (RB2, RB3): 15 s, 50 pages, its own
 * heap and 256 MB of the process's memory. Not counted as a parse on this thread, which would make its own timeout look
 * like another read's, and not queued behind the cycle's parses (`oneParseAtATime`), which a person would wait on. A
 * timeout while another PDF was read in this process may not be the file's: a plain Error, so the person is asked to try
 * again in a moment. Any other stop, its memory included, is the file's: it "could not be read". A reader that could
 * not start is thrown as it is.
 */
async function unmeasuredPdfText(bytes: Uint8Array): Promise<TextRead> {
  try {
    return await textInWorker(bytes, REQUEST_PDF_LIMITS);
  } catch (error) {
    if (!(error instanceof PdfWorkerRefusal)) throw error;
    if (error.why === "timeout" && error.retry) throw new Error("the PDF reader ran out of time while other PDFs were read: try again", { cause: error });
    throw new DocumentReadError("unsupported", PDF_UNREADABLE);
  }
}

/** The most PDFs read from one email (RB5): each may need a worker, and workers share the process's memory. */
const MAX_EMAIL_PDFS = 3;

/**
 * An email's subject, its text and the text of the PDFs attached, without
 * the MIME around them (review I6): the first three, one after another
 * (RB5), saying when there were more (`pdfsLeftOut`), for the draft to warn
 * of. An attachment that cannot be read is left out; the message's own
 * text still is. A reader stopped for a reason that may not be the file's
 * fails the read, to be tried again, rather than drop the invoice.
 */
async function emailText(bytes: Uint8Array): Promise<TextRead> {
  const parts = emailParts(bytes);
  const attachments: string[] = [];
  let cut = false;
  for (const pdf of parts.pdfs.slice(0, MAX_EMAIL_PDFS)) {
    try {
      const read = await pdfText(pdf);
      attachments.push(read.text);
      cut ||= read.cut;
    } catch (error) {
      if (!(error instanceof DocumentReadError)) throw error;
    }
  }
  const read = [parts.subject ? `Subject: ${parts.subject}` : "", ...parts.text, ...attachments].filter((text) => text.trim()).join("\n\n");
  // A file named .eml that holds no message structure at all is read as the text it is.
  if (!read.trim()) return { text: new TextDecoder("utf-8").decode(bytes), cut: false };
  return { text: read, cut, pdfsLeftOut: parts.pdfs.length > MAX_EMAIL_PDFS };
}

export async function readDocument(input: DocumentInput): Promise<ReadDocument> {
  if ("text" in input) {
    const bytes = new TextEncoder().encode(input.text);
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new DocumentReadError("too_large");
    return finish("text", input.text, sha256(bytes));
  }

  const { bytes, name, type } = input;
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new DocumentReadError("too_large");
  if (bytes.length === 0) throw new DocumentReadError("empty");
  if (isPdf(bytes)) return finishRead("pdf", await pdfText(bytes), sha256(bytes));
  if (isEmail(name, type) && !bytes.includes(0)) return finishRead("email", await emailText(bytes), sha256(bytes));
  // A binary file named .txt is not text: a NUL byte gives it away.
  if (isText(name, type) && !bytes.includes(0)) return finish("text", new TextDecoder("utf-8").decode(bytes), sha256(bytes));
  throw new DocumentReadError("unsupported");
}

/** The pages' text joined as unpdf's `mergePages` joins it: a line break between pages, spaces collapsed, at most one blank line. */
function mergedPages(pages: readonly string[]): string {
  return pages.join("\n").replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/** A PDF's text read in a worker under `limits` (./pdf-worker.ts), to the text unpdf gives it on this thread. */
async function textInWorker(bytes: Uint8Array, limits: PdfLimits): Promise<TextRead> {
  const { pages, cut } = await pdfPagesInWorker(bytes, { ...limits, maxChars: MAX_DOCUMENT_CHARS });
  return { text: mergedPages(pages), cut };
}

/**
 * A PDF read as `readDocument` reads one, to the same text, but refused whenever the pre-scan refuses it, and always
 * parsed in a worker thread under `PDF_LIMITS` (./pdf-prescan.ts, ./pdf-worker.ts, document checks DK3): for a file
 * someone outside the workspace sent, which the cycle reads beside every other workspace's cycle. A PDF whose streams
 * would decode past 16 MB, or that the pre-scan cannot measure (an encrypted file; LZW, run-length or Brotli where text
 * is read), that runs out its time or its own heap, has more than 50 pages or cannot be parsed, is refused as one that
 * "could not be read"; one whose text passed 20,000 characters before its last page is cut there, and says so. A stop
 * that may not be the file's doing (`PdfWorkerRefusal` with `retry`) is thrown as it is, and so is a reader that could
 * not start, a plain `Error`: the caller tries either again later. The caller waits for its turn (`oneParseAtATime`)
 * before this.
 */
export async function readPdfBounded(bytes: Uint8Array, limits: Partial<PdfLimits> = {}): Promise<ReadDocument> {
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new DocumentReadError("too_large");
  if (bytes.length === 0) throw new DocumentReadError("empty");
  if (!isPdf(bytes)) throw new DocumentReadError("unsupported");
  if (prescanPdf(bytes).refused) throw new DocumentReadError("unsupported", PDF_UNREADABLE);
  let read: TextRead;
  try {
    read = await textInWorker(bytes, { ...PDF_LIMITS, ...limits });
  } catch (error) {
    if (error instanceof PdfWorkerRefusal && !error.retry) throw new DocumentReadError("unsupported", PDF_UNREADABLE);
    throw error;
  }
  return finishRead("pdf", read, sha256(bytes));
}
