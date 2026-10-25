/**
 * Small PDFs built in code, for the bounded PDF reader (document checks DK3): a valid file of numbered objects with
 * its cross-reference table, so pdf.js reads it as written.
 */

/** A PDF of `objects`, numbered from 1; the first must be the catalog. */
export function buildPdf(objects: readonly string[]): Uint8Array<ArrayBuffer> {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

const stream = (dict: string, data: string) => `<< ${dict} /Length ${Buffer.byteLength(data, "latin1")} >>\nstream\n${data}\nendstream`;
const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

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
