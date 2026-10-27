import zlib from "node:zlib";

/**
 * Small PDFs built in code, for the bounded PDF reader (document checks DK3): a valid file of numbered objects with
 * its cross-reference table, so pdf.js reads it as written.
 */

/** A PDF of `objects`, numbered from 1; the first must be the catalog. `trailer` adds entries to the trailer. */
export function buildPdf(objects: readonly string[], { trailer = "" }: { trailer?: string } = {}): Uint8Array<ArrayBuffer> {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer}>>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

/** A stream object's body: `dict`, its length, and its data, which may be binary. */
export const streamObject = (dict: string, data: string | Uint8Array) => {
  const text = typeof data === "string" ? data : Buffer.from(data).toString("latin1");
  return `<< ${dict} /Length ${Buffer.byteLength(text, "latin1")} >>\nstream\n${text}\nendstream`;
};
const stream = streamObject;
export const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
/** A line of invoice text, as a content stream draws it. */
export const INVOICE_LINE = "BT /F1 12 Tf 36 760 Td (Northwind Hosting invoice INV-2207, total due 200.00 USDC, purchase order PO-1042) Tj ET\n";

/**
 * One page that draws a form, which draws the next form `fanOut` times, `depth` forms deep: a few kilobytes that make
 * pdf.js extract `fanOut ** depth` runs of text. At fan-out 10 and depth 6, about 2 KB, unpdf 1.8.1 takes about 95 s.
 */
export function nestedFormsPdf({ fanOut, depth }: { fanOut: number; depth: number }): Uint8Array<ArrayBuffer> {
  const forms: string[] = [];
  for (let level = 0; level <= depth; level++) {
    const id = 6 + level;
    const leaf = level === depth;
    const content = leaf ? "BT /F1 12 Tf 10 10 Td (Invoice total due) Tj ET" : Array.from({ length: fanOut }, () => `/X${level + 1} Do`).join("\n");
    const resources = leaf ? "/Resources << /Font << /F1 4 0 R >> >>" : `/Resources << /XObject << /X${level + 1} ${id + 1} 0 R >> /Font << /F1 4 0 R >> >>`;
    forms.push(stream(`/Type /XObject /Subtype /Form /BBox [0 0 612 792] ${resources}`, content));
  }
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /X0 6 0 R >> /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    FONT,
    stream("", "/X0 Do"),
    ...forms,
  ]);
}

/** `count` pages, each "Page N of M:" and then `line`, `linesPerPage` times, a line each. */
export function pagesPdf(count: number, line = "Northwind Hosting invoice INV-2207, total due 200.00 USDC", linesPerPage = 1): Uint8Array<ArrayBuffer> {
  const kids: string[] = [];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", FONT];
  for (let n = 0; n < count; n++) {
    const pageId = 4 + n * 2;
    kids.push(`${pageId} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    const rest = Array.from({ length: linesPerPage - 1 }, () => `T* (${line}) Tj`).join(" ");
    objects.push(stream("", `BT /F1 10 Tf 14 TL 36 760 Td (Page ${n + 1} of ${count}: ${line}) Tj ${rest} ET`));
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${count} >>`;
  return buildPdf(objects);
}

/**
 * One page: its font is object 4, its content stream object 5 (`contents`, a whole stream object), and `more` follow
 * from object 6. `resources` adds to the page's resources.
 */
export function onePagePdf(
  contents: string,
  { more = [], resources = "", trailer = "" }: { more?: readonly string[]; resources?: string; trailer?: string } = {}
): Uint8Array<ArrayBuffer> {
  return buildPdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> ${resources} >> /Contents 5 0 R >>`,
      FONT,
      contents,
      ...more,
    ],
    { trailer }
  );
}

/**
 * `data` as an LZWDecode stream that pdf.js decodes back to it: each byte a 9-bit code of its own, with a clear-table
 * code every 250, so the codes never widen. No compression: a filter the pre-scan cannot measure, on readable text.
 */
export function lzwLiterals(data: string): Buffer {
  const codes = [256];
  [...Buffer.from(data, "latin1")].forEach((byte, index) => {
    if (index > 0 && index % 250 === 0) codes.push(256);
    codes.push(byte);
  });
  codes.push(257);
  const out: number[] = [];
  let bits = 0;
  let held = 0;
  for (const code of codes) {
    held = (held << 9) | code;
    bits += 9;
    while (bits >= 8) {
      out.push((held >> (bits - 8)) & 0xff);
      bits -= 8;
    }
    held &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((held << (8 - bits)) & 0xff);
  return Buffer.from(out);
}

/**
 * `pdf` with one more object after its end: a stream no page draws, under a filter the pre-scan cannot measure (LZW).
 * pdf.js never decodes it, and reads the file as before; the pre-scan refuses the file for it.
 */
export function withUnmeasuredStream(pdf: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.concat([pdf, Buffer.from(`99 0 obj\n${streamObject("/Filter /LZWDecode", lzwLiterals("q Q"))}\nendobj\n`, "latin1")]));
}

const MB = 2 ** 20;
const ADLER = BigInt(65521);

/** Adler-32's two sums after `count` more bytes of value `byte`. */
function adlerRun([a, b]: [bigint, bigint], byte: bigint, count: bigint): [bigint, bigint] {
  return [(a + count * byte) % ADLER, (b + count * a + (byte * count * (count + BigInt(1))) / BigInt(2)) % ADLER];
}

/**
 * A zlib stream of `head` and then `spacesMb` MB of spaces: one compressed megabyte repeated, so the spaces are never
 * held whole. About a kilobyte for each megabyte it decodes to.
 */
export function deflatedWithSpaces(head: string, spacesMb: number): Buffer {
  const flush = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
  const headBytes = Buffer.from(head, "latin1");
  const megabyte = zlib.deflateRawSync(Buffer.alloc(MB, 0x20), { level: 9, ...flush });
  let sums: [bigint, bigint] = [BigInt(1), BigInt(0)];
  for (const byte of headBytes) sums = adlerRun(sums, BigInt(byte), BigInt(1));
  const [a, b] = adlerRun(sums, BigInt(0x20), BigInt(spacesMb) * BigInt(MB));
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(Number((b << BigInt(16)) | a));
  const parts: Buffer[] = [Buffer.from([0x78, 0xda]), zlib.deflateRawSync(headBytes, flush)];
  for (let n = 0; n < spacesMb; n++) parts.push(megabyte);
  parts.push(zlib.deflateRawSync(Buffer.alloc(0)), adler);
  return Buffer.concat(parts);
}

/**
 * One page whose content stream is a line of invoice text and then `decodedMb` MB of spaces, deflated (`twice`: deflated
 * again, under `[/FlateDecode /FlateDecode]`). A valid PDF that pdf.js reads to that line, decoding every megabyte.
 */
export function inflateBombPdf(decodedMb: number, { twice = false }: { twice?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const once = deflatedWithSpaces(INVOICE_LINE, decodedMb);
  const data = twice ? zlib.deflateSync(once) : once;
  return onePagePdf(stream(twice ? "/Filter [/FlateDecode /FlateDecode]" : "/Filter /FlateDecode", data));
}

/** Bits written into bytes as deflate packs them: header fields from their lowest bit, Huffman codes from their highest. */
class DeflateBits {
  private readonly bytes: number[] = [];
  private byte = 0;
  private filled = 0;
  private bit(value: number) {
    this.byte |= value << this.filled;
    if (++this.filled === 8) {
      this.bytes.push(this.byte);
      this.byte = 0;
      this.filled = 0;
    }
  }
  field(value: number, count: number) {
    for (let i = 0; i < count; i++) this.bit((value >> i) & 1);
  }
  code(value: number, count: number) {
    for (let i = count - 1; i >= 0; i--) this.bit((value >> i) & 1);
  }
  done(): Buffer {
    if (this.filled) this.bytes.push(this.byte);
    return Buffer.from(this.bytes);
  }
}

/**
 * A zlib stream that pdf.js decodes to about `decodedMb` MB of zero bytes and zlib refuses at once: one block of fixed
 * codes, each a copy of 258 bytes from 1 byte back, the first of which reaches before the stream's start. zlib says
 * "invalid distance too far back"; pdf.js copies from before its buffer, reads nothing there, and writes a zero.
 */
export function copiesFromBeforeStart(decodedMb: number): Buffer {
  const bits = new DeflateBits();
  bits.field(1, 1); // the last block
  bits.field(1, 2); // of fixed codes
  for (let copies = Math.ceil((decodedMb * MB) / 258); copies > 0; copies--) {
    bits.code(0b11000101, 8); // length 258 (code 285)
    bits.code(0, 5); // distance 1 (code 0)
  }
  bits.code(0, 7); // the end of the block (code 256)
  return Buffer.concat([Buffer.from([0x78, 0x9c]), bits.done(), Buffer.alloc(4)]);
}

/** `bytes` in ASCII85, as a PDF's ASCII85Decode reads it, with its closing "~>". */
export function ascii85(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; at += 4) {
    const group = bytes.subarray(at, at + 4);
    const padded = new Uint8Array(4);
    padded.set(group);
    let value = ((padded[0] << 24) | (padded[1] << 16) | (padded[2] << 8) | padded[3]) >>> 0;
    if (group.length === 4 && value === 0) {
      out += "z";
      continue;
    }
    const digits: string[] = [];
    for (let i = 0; i < 5; i++) {
      digits.unshift(String.fromCharCode(33 + (value % 85)));
      value = Math.floor(value / 85);
    }
    out += digits.slice(0, group.length + 1).join("");
  }
  return `${out}~>`;
}
