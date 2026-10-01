/**
 * An email, as an `.eml` file holds it, taken apart into what a person would
 * read: the subject, the message's text, and its PDF attachments (invoice
 * from a document, review I6). Enough MIME for the invoices vendors send:
 * nested multiparts, base64 and quoted-printable, UTF-8 and Latin-1. The
 * model is never shown headers, boundaries or base64.
 */

export interface EmailParts {
  subject: string | null;
  /** The message's text: its plain parts, or its HTML parts as text when it has none. */
  text: string[];
  /** The bytes of each PDF attached. */
  pdfs: Uint8Array[];
}

interface Part {
  headers: Map<string, string>;
  body: string;
}

/** Headers and body, split at the first blank line; folded header lines unfolded. */
function splitPart(raw: string): Part {
  const at = raw.search(/\r?\n\r?\n/);
  const head = at === -1 ? raw : raw.slice(0, at);
  const body = at === -1 ? "" : raw.slice(at).replace(/^\r?\n\r?\n/, "");
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body };
}

/** A parameter of a header value: `boundary`, `charset`, `filename`, `name`. */
function parameter(value: string, name: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(value);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/** The body's bytes, its transfer encoding undone. The body string holds one byte per character. */
function decodeBody(body: string, encoding: string): Uint8Array {
  const kind = encoding.toLowerCase();
  if (kind === "base64") return new Uint8Array(Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64"));
  if (kind === "quoted-printable") {
    const unfolded = body.replace(/=\r?\n/g, "");
    const bytes: number[] = [];
    for (let index = 0; index < unfolded.length; index += 1) {
      const hex = unfolded.slice(index + 1, index + 3);
      if (unfolded[index] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        index += 2;
      } else {
        bytes.push(unfolded.charCodeAt(index) & 0xff);
      }
    }
    return new Uint8Array(bytes);
  }
  return new Uint8Array(Buffer.from(body, "latin1"));
}

function decodeText(bytes: Uint8Array, charset: string | null): string {
  const name = (charset ?? "utf-8").toLowerCase();
  const latin1 = ["iso-8859-1", "latin1", "windows-1252", "us-ascii", "ascii"].includes(name);
  return new TextDecoder(latin1 ? "latin1" : "utf-8").decode(bytes);
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** HTML as the text a reader sees: no styles, scripts or tags; block ends as line breaks. */
function htmlText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, code: string) => {
      if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
      return ENTITIES[code.toLowerCase()] ?? entity;
    });
}

function walk(part: Part, plain: string[], html: string[], pdfs: Uint8Array[], depth: number): void {
  const type = part.headers.get("content-type") ?? "text/plain";
  const mime = type.split(";")[0].trim().toLowerCase();
  const encoding = part.headers.get("content-transfer-encoding") ?? "7bit";

  if (mime.startsWith("multipart/")) {
    const boundary = parameter(type, "boundary");
    if (!boundary || depth > 5) return;
    const delimiter = `--${boundary}`;
    const sections = part.body.split(delimiter).slice(1);
    for (const section of sections) {
      if (section.startsWith("--")) break;
      walk(splitPart(section.replace(/^[ \t]*\r?\n/, "")), plain, html, pdfs, depth + 1);
    }
    return;
  }

  const name = parameter(part.headers.get("content-disposition") ?? "", "filename") ?? parameter(type, "name") ?? "";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
    pdfs.push(decodeBody(part.body, encoding));
    return;
  }
  if (mime === "text/plain") plain.push(decodeText(decodeBody(part.body, encoding), parameter(type, "charset")));
  else if (mime === "text/html") html.push(htmlText(decodeText(decodeBody(part.body, encoding), parameter(type, "charset"))));
}

/** A header's encoded words, `=?UTF-8?B?…?=` or `=?UTF-8?Q?…?=`, as text. */
function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_word, charset: string, kind: string, data: string) => {
    const bytes = kind.toUpperCase() === "B" ? decodeBody(data, "base64") : decodeBody(data.replace(/_/g, " "), "quoted-printable");
    return decodeText(bytes, charset);
  });
}

/** The parts of an email given as its raw bytes. */
export function emailParts(bytes: Uint8Array): EmailParts {
  // One character per byte, so base64 and quoted-printable bodies decode to the bytes they encode.
  const message = splitPart(Buffer.from(bytes).toString("latin1"));
  const plain: string[] = [];
  const html: string[] = [];
  const pdfs: Uint8Array[] = [];
  walk(message, plain, html, pdfs, 0);
  const raw = message.headers.get("subject");
  const subject = raw ? decodeWords(raw) : null;
  return { subject, text: plain.length > 0 ? plain : html, pdfs };
}
