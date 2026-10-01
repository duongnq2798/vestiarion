import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readDocument } from "@/lib/invoice-document/read";

/**
 * An invoice that arrives by email (review I6): the model is shown the
 * message's own text and its PDF attachment's text, decoded, never the raw
 * MIME, its base64 or its headers.
 */

const PDF = readFileSync(path.join(__dirname, "fixtures", "invoice-document", "northwind-inv-2207.pdf"));
const CRLF = "\r\n";
const wrap = (base64: string) => base64.replace(/.{76}/g, `$&${CRLF}`);
const eml = (lines: string[]) => new TextEncoder().encode(lines.join(CRLF));
const read = (bytes: Uint8Array, name = "invoice.eml", type = "message/rfc822") => readDocument({ bytes, name, type });

describe("reading an invoice that arrives by email", () => {
  it("reads the message's text and its PDF attachment, without the MIME around them", async () => {
    const bytes = eml([
      "From: Northwind Billing <billing@northwind.example>",
      "Subject: Invoice INV-2207",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "This is a multi-part message in MIME format.",
      "--outer",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Hello, please find attached our invoice INV-2207, due on 31 October. The tot=",
      "al is 200.00 USDC =E2=80=94 thank you.",
      "--outer",
      'Content-Type: application/pdf; name="INV-2207.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="INV-2207.pdf"',
      "",
      wrap(PDF.toString("base64")),
      "--outer--",
      "",
    ]);
    const document = await read(bytes);
    expect(document.kind).toBe("email");
    expect(document.text).toContain("Subject: Invoice INV-2207");
    expect(document.text).toContain("The total is 200.00 USDC — thank you.");
    expect(document.text).toContain("Your purchase order: PO-1042");
    expect(document.text).toContain("Total due (USDC) 200.00");
    expect(document.text).not.toContain("JVBERi0");
    expect(document.text).not.toContain("Content-Transfer-Encoding");
    expect(document.text).not.toContain("billing@northwind.example>");
  });

  it("reads the HTML part when a message has no plain text, without its tags", async () => {
    const bytes = eml([
      "Subject: Invoice H-77",
      'Content-Type: multipart/alternative; boundary="alt"',
      "",
      "--alt",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrap(Buffer.from("<html><style>p{color:red}</style><body><p>Harbor Office Supply</p><p>Total due&nbsp;75.00 USDC</p><script>alert(1)</script></body></html>").toString("base64")),
      "--alt--",
    ]);
    const document = await read(bytes);
    expect(document.text).toContain("Harbor Office Supply");
    expect(document.text).toContain("Total due 75.00 USDC");
    expect(document.text).not.toMatch(/<p>|color:red|alert/);
  });

  it("reads a message that is a single quoted-printable part", async () => {
    const bytes = eml(["Subject: Invoice 9", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", "Total due 12.50 US=", "DC"]);
    expect((await read(bytes)).text).toContain("Total due 12.50 USDC");
  });

  it("reads a message with no MIME headers as its own text", async () => {
    expect((await read(eml(["Subject: Invoice 10", "", "Total due 20.00 USDC"]))).text).toContain("Total due 20.00 USDC");
  });
});
