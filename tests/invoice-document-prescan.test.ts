import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { inflateAsPdfjs, prescanPdf, PRESCAN_LIMITS } from "@/lib/invoice-document/pdf-prescan";
import {
  ascii85,
  buildPdf,
  copiesFromBeforeStart,
  deflatedWithSpaces,
  FONT,
  inflateBombPdf,
  INVOICE_LINE,
  nestedFormsPdf,
  onePagePdf,
  pagesPdf,
  streamObject,
} from "./support/pdf-files";

/**
 * The PDF pre-scan (docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md DK3): before pdf.js sees a
 * file, every stream it would decode to read text is decoded as pdf.js decodes it, counting the bytes, against one
 * budget for the whole file. A file of a few hundred kilobytes that would decode to gigabytes is refused there, in a
 * fraction of a second, having decoded no more than the budget. In strict mode, the cycle's, a stream it cannot measure
 * is refused too; in lenient mode, readDocument's, only a file measured over the budget is.
 */

const MB = 2 ** 20;
const file = (...parts: string[]) => new Uint8Array(readFileSync(path.join(process.cwd(), ...parts)));
const strict = (bytes: Uint8Array) => prescanPdf(bytes, { strict: true });
const lenient = (bytes: Uint8Array) => prescanPdf(bytes, { strict: false });
const latin1 = (text: string) => Buffer.from(text, "latin1");
/** An image pdf.js never decodes to read text: 48 MB of pixels, deflated to about 50 KB. */
const IMAGE = streamObject(
  "/Type /XObject /Subtype /Image /Width 4096 /Height 4096 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode",
  deflatedWithSpaces("", 48)
);

describe("prescanPdf (DK3)", () => {
  it("passes every PDF the tests read, each decoding to far less than its 16 MB budget", () => {
    expect(PRESCAN_LIMITS).toEqual({ maxDecodedBytes: 16 * MB, maxStreams: 10_000, maxWorkBytes: 64 * MB });
    for (const [label, bytes] of [
      ["northwind", file("tests", "fixtures", "invoice-document", "northwind-inv-2207.pdf")],
      ["scan", file("tests", "fixtures", "invoice-document", "scan.pdf")],
      ["blindpay", file("public", "downloads", "blindpay-development-test-document.pdf")],
      ["50 pages", pagesPdf(50)],
      ["nested forms", nestedFormsPdf({ fanOut: 10, depth: 6 })],
    ] as const) {
      const scan = strict(bytes);
      expect(scan.refused, label).toBeNull();
      expect(scan.decodedBytes, label).toBeLessThan(MB);
    }
  });

  it("counts a deflated content stream to the byte, and each step of a chain", () => {
    const content = INVOICE_LINE.repeat(100);
    const deflated = zlib.deflateSync(latin1(content));
    expect(strict(onePagePdf(streamObject("/Filter /FlateDecode", deflated)))).toEqual({ refused: null, decodedBytes: content.length });
    // ASCII85 first, then the inflate it feeds: both outputs are held at once, so both count.
    expect(strict(onePagePdf(streamObject("/Filter [/ASCII85Decode /FlateDecode]", ascii85(deflated))))).toEqual({
      refused: null,
      decodedBytes: deflated.length + content.length,
    });
    // ASCIIHex, which ends at its ">".
    expect(strict(onePagePdf(streamObject("/Filter /ASCIIHexDecode", `${latin1(INVOICE_LINE).toString("hex")}>`)))).toEqual({
      refused: null,
      decodedBytes: INVOICE_LINE.length,
    });
  });

  it("refuses a file of under a megabyte that would decode to 600 MB, in well under a second, having decoded only its budget", () => {
    for (const twice of [false, true]) {
      const bomb = inflateBombPdf(600, { twice });
      expect(bomb.byteLength).toBeLessThan(MB);
      const started = Date.now();
      const scan = strict(bomb);
      expect(scan.refused, String(twice)).toBe("decoded_limit");
      expect(scan.decodedBytes, String(twice)).toBeLessThan(17 * MB);
      expect(Date.now() - started, String(twice)).toBeLessThan(3_000);
      // Lenient mode refuses a file measured over the budget too.
      expect(lenient(bomb).refused, String(twice)).toBe("decoded_limit");
    }
  });

  it("decodes as pdf.js does, so a stream zlib refuses is still measured: copies from before its start", () => {
    const data = copiesFromBeforeStart(64);
    expect(data.byteLength).toBeLessThan(MB);
    expect(() => zlib.inflateSync(data)).toThrow(/too far back/);
    const inflated = inflateAsPdfjs(data, 128 * MB);
    expect(inflated.over).toBe(false);
    expect(inflated.length).toBeGreaterThanOrEqual(64 * MB);
    expect(strict(onePagePdf(streamObject("/Filter /FlateDecode", data))).refused).toBe("decoded_limit");
  });

  it("decodes to the same bytes as zlib every stream zlib can decode", () => {
    const text = latin1(INVOICE_LINE.repeat(400));
    const noise = crypto.randomBytes(40_000);
    const mixed = Buffer.concat([text, noise, text, Buffer.alloc(70_000, 0x20)]);
    for (const [label, original, options] of [
      ["stored", mixed, { level: 0 }],
      ["fast", mixed, { level: 1 }],
      ["default", mixed, {}],
      ["best", mixed, { level: 9 }],
      ["fixed codes", mixed, { strategy: zlib.constants.Z_FIXED }],
      ["Huffman only", mixed, { strategy: zlib.constants.Z_HUFFMAN_ONLY }],
      ["runs", mixed, { strategy: zlib.constants.Z_RLE }],
      ["empty", Buffer.alloc(0), {}],
    ] as const) {
      const inflated = inflateAsPdfjs(zlib.deflateSync(original, options));
      expect(inflated.over, label).toBe(false);
      expect(Buffer.from(inflated.bytes).equals(original), label).toBe(true);
    }
    // At its limit it stops, and says so.
    expect(inflateAsPdfjs(zlib.deflateSync(mixed), 1000)).toMatchObject({ over: true });
  });

  it("finds a filter however the dictionary writes it: abbreviated, escaped, as /F, in another object, or after a comment", () => {
    const data = deflatedWithSpaces(INVOICE_LINE, 64);
    for (const [label, dict, more] of [
      ["Fl", "/Filter /Fl", []],
      ["escaped", "/Filter /Fl#61teDecode", []],
      ["/F", "/F /FlateDecode", []],
      ["in another object", "/Filter 6 0 R", ["/FlateDecode"]],
      ["in an array of other objects", "/Filter [6 0 R]", ["/FlateDecode"]],
      ["after a comment", "% a comment\n/Filter /FlateDecode", []],
    ] as const) {
      expect(strict(onePagePdf(streamObject(dict, data), { more })).refused, label).toBe("decoded_limit");
    }
  });

  it("counts a stream that no object it could read leads to", () => {
    const pdf = Buffer.concat([
      Buffer.from(onePagePdf(streamObject("", INVOICE_LINE))),
      latin1("<< /Filter /FlateDecode >>\nstream\n"),
      deflatedWithSpaces(INVOICE_LINE, 64),
      latin1("\nendstream\n"),
    ]);
    expect(strict(pdf).refused).toBe("decoded_limit");
  });

  it("leaves out an image pdf.js does not decode to read text, and counts the same stream given as the page's text", () => {
    const drawn = onePagePdf(streamObject("", `q 100 0 0 100 36 600 cm /Im1 Do Q ${INVOICE_LINE}`), { more: [IMAGE], resources: "/XObject << /Im1 6 0 R >>" });
    expect(strict(drawn).refused).toBeNull();
    expect(strict(drawn).decodedBytes).toBeLessThan(MB);
    // Named an image, but the page's content: pdf.js decodes it.
    expect(strict(onePagePdf(IMAGE)).refused).toBe("decoded_limit");
    // One of the page's contents, through an array in another object.
    const listed = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
      FONT,
      IMAGE,
      "[7 0 R 5 0 R]",
      streamObject("", INVOICE_LINE),
    ]);
    expect(strict(listed).refused).toBe("decoded_limit");
    // A page kept in an object stream, whose content is that image.
    const header = "3 0 ";
    const page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>";
    const packed = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "null",
      FONT,
      IMAGE,
      streamObject(`/Type /ObjStm /N 1 /First ${header.length} /Filter /FlateDecode`, zlib.deflateSync(latin1(header + page))),
    ]);
    expect(strict(packed).refused).toBe("decoded_limit");
  });

  it("lets an image keep its own encodings, and refuses those, LZW, run-length and Brotli on a stream read for text", () => {
    const jpeg = streamObject("/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", "\xff\xd8\xff\xd9");
    expect(strict(onePagePdf(streamObject("", `/Im1 Do ${INVOICE_LINE}`), { more: [jpeg], resources: "/XObject << /Im1 6 0 R >>" })).refused).toBeNull();
    for (const filter of ["/LZWDecode", "/LZW", "/RunLengthDecode", "/BrotliDecode", "/DCTDecode", "/JBIG2Decode", "/CCITTFaxDecode", "/JPXDecode", "[/FlateDecode /LZWDecode]"]) {
      const pdf = onePagePdf(streamObject(`/Filter ${filter}`, "anything"));
      expect(strict(pdf).refused, filter).toBe("unbounded_filter");
      expect(lenient(pdf).refused, filter).toBeNull();
    }
    // A filter kept in an object it cannot find cannot be measured either.
    expect(strict(onePagePdf(streamObject("/Filter 9 0 R", "anything"))).refused).toBe("unbounded_filter");
  });

  it("refuses an encrypted PDF in strict mode, whose streams it cannot see into, and leaves it to pdf.js in lenient mode", () => {
    const pdf = onePagePdf(streamObject("", INVOICE_LINE), { more: ["<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>"], trailer: "/Encrypt 6 0 R " });
    expect(strict(pdf).refused).toBe("encrypted");
    expect(lenient(pdf).refused).toBeNull();
  });

  it("refuses a file of more streams, or more work, than it takes on in strict mode, and stops there in lenient mode", () => {
    expect(prescanPdf(pagesPdf(5), { strict: true, limits: { maxStreams: 3 } }).refused).toBe("too_complex");
    expect(prescanPdf(pagesPdf(5), { strict: false, limits: { maxStreams: 3 } }).refused).toBeNull();
    expect(prescanPdf(inflateBombPdf(2), { strict: true, limits: { maxWorkBytes: 1_000 } }).refused).toBe("too_complex");
    expect(prescanPdf(inflateBombPdf(2), { strict: false, limits: { maxWorkBytes: 1_000 } }).refused).toBeNull();
  });
});
