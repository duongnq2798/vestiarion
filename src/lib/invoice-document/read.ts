import { createHash } from "node:crypto";
import { extractText, getDocumentProxy } from "unpdf";
import { emailParts } from "./email";

/**
 * An invoice document to plain text, for the model to read (invoice from a
 * document D1, D2). A PDF is read from its text layer on the server; a text
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

async function pdfText(bytes: Uint8Array): Promise<string> {
  try {
    // unpdf takes ownership of the buffer it is given: hand it a copy, so the hash is of what was sent.
    const { text } = await extractText(await getDocumentProxy(bytes.slice()), { mergePages: true });
    return text;
  } catch {
    throw new DocumentReadError("unsupported", "This PDF could not be read. Paste the invoice's text instead.");
  }
}

/**
 * An email's subject, its text and the text of each PDF attached, without
 * the MIME around them (review I6). An attachment that cannot be read is
 * left out; the message's own text still is.
 */
async function emailText(bytes: Uint8Array): Promise<string> {
  const parts = emailParts(bytes);
  const attachments = await Promise.all(parts.pdfs.map((pdf) => pdfText(pdf).catch(() => "")));
  const read = [parts.subject ? `Subject: ${parts.subject}` : "", ...parts.text, ...attachments].filter((text) => text.trim()).join("\n\n");
  // A file named .eml that holds no message structure at all is read as the text it is.
  return read.trim() ? read : new TextDecoder("utf-8").decode(bytes);
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
  if (isPdf(bytes)) return finish("pdf", await pdfText(bytes), sha256(bytes));
  if (isEmail(name, type) && !bytes.includes(0)) return finish("email", await emailText(bytes), sha256(bytes));
  // A binary file named .txt is not text: a NUL byte gives it away.
  if (isText(name, type) && !bytes.includes(0)) return finish("text", new TextDecoder("utf-8").decode(bytes), sha256(bytes));
  throw new DocumentReadError("unsupported");
}
