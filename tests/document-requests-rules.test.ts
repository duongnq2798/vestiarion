import { describe, expect, it } from "vitest";
import {
  documentCheckLine,
  documentRequestAllowed,
  documentRequestLine,
  documentRequestsSettingOf,
  emailDomainOf,
  MAX_ATTACHED_DOCUMENT_BYTES,
  missingDocuments,
  missingWords,
  readDocumentFields,
  sniffDocumentType,
  type DocumentCheckView,
  type RequestHistory,
} from "@/lib/document-requests/rules";
import { MAX_DOCUMENT_BYTES } from "@/lib/invoice-document/read";
import { documentRequestUrl, documentTokenHash, generateDocumentToken } from "@/lib/document-requests/token";

/**
 * What code decides about asking a vendor for a missing document (docs/superpowers/specs/2026-10-23-document-requests-design.md):
 * the setting (ER1), which bills qualify (ER2), the one-time link (ER4), what the vendor may send (ER5) and what a bill's
 * card says (ER3, ER4, ER6). Pure, so the stage, the page and the cards read it the same way.
 */

const NOW = Date.parse("2026-10-23T09:00:00Z");
const DAY = 86_400_000;

const facts = (over: Partial<Parameters<typeof documentRequestAllowed>[0]> = {}): Parameters<typeof documentRequestAllowed>[0] => ({
  status: "awaiting_info",
  missing: ["purchase_order"],
  noticeEmail: "ap@northstar.example",
  frozen: false,
  riskLevel: "clear",
  requests: [],
  now: NOW,
  ...over,
});

const past = (status: RequestHistory["status"], daysAgo: number, over: Partial<RequestHistory> = {}): RequestHistory => ({
  status,
  createdAt: new Date(NOW - (daysAgo + 14) * DAY).toISOString(),
  sentAt: new Date(NOW - (daysAgo + 14) * DAY).toISOString(),
  expiresAt: new Date(NOW - daysAgo * DAY).toISOString(),
  answeredAt: status === "answered" ? new Date(NOW - daysAgo * DAY).toISOString() : null,
  ...over,
});

describe("the setting (ER1)", () => {
  it("reads off, shadow and on, and anything else as off", () => {
    expect(documentRequestsSettingOf("on")).toBe("on");
    expect(documentRequestsSettingOf("shadow")).toBe("shadow");
    expect(documentRequestsSettingOf("off")).toBe("off");
    expect(documentRequestsSettingOf(null)).toBe("off");
    expect(documentRequestsSettingOf("always")).toBe("off");
  });
});

describe("what is missing", () => {
  it("names a purchase order and a goods receipt, as missingDetails reads them", () => {
    expect(missingDocuments(null)).toEqual([]);
    expect(missingDocuments({ poReference: true, goodsReceived: false })).toEqual(["purchase_order"]);
    expect(missingDocuments({ poReference: false, goodsReceived: true })).toEqual(["goods_receipt"]);
    expect(missingDocuments({ poReference: true, goodsReceived: true })).toEqual(["purchase_order", "goods_receipt"]);
    expect(missingWords(["purchase_order"])).toBe("the purchase order");
    expect(missingWords(["goods_receipt"])).toBe("the goods receipt");
    expect(missingWords(["purchase_order", "goods_receipt"])).toBe("the purchase order and the goods receipt");
  });
});

describe("which bills qualify (ER2)", () => {
  it("allows a bill waiting for information, missing a document, its vendor reachable and clear", () => {
    expect(documentRequestAllowed(facts())).toEqual({ allowed: true });
    expect(documentRequestAllowed(facts({ riskLevel: "medium" }))).toEqual({ allowed: true });
  });

  it("refuses each thing that would make the request wrong, and says which", () => {
    expect(documentRequestAllowed(facts({ status: "held" }))).toEqual({ allowed: false, because: "not_waiting" });
    expect(documentRequestAllowed(facts({ missing: [] }))).toEqual({ allowed: false, because: "nothing_missing" });
    expect(documentRequestAllowed(facts({ noticeEmail: null }))).toEqual({ allowed: false, because: "no_email" });
    expect(documentRequestAllowed(facts({ noticeEmail: "not an email" }))).toEqual({ allowed: false, because: "no_email" });
    expect(documentRequestAllowed(facts({ frozen: true }))).toEqual({ allowed: false, because: "frozen" });
    expect(documentRequestAllowed(facts({ riskLevel: "high" }))).toEqual({ allowed: false, because: "high_risk" });
  });

  it("asks once at a time, waits 7 days after an answer or an expiry, and never asks again after a revoke", () => {
    expect(documentRequestAllowed(facts({ requests: [{ ...past("open", -3), sentAt: new Date(NOW - DAY).toISOString() }] }))).toEqual({ allowed: false, because: "open_request" });
    expect(documentRequestAllowed(facts({ requests: [{ status: "drafted", createdAt: new Date(NOW - DAY).toISOString(), sentAt: null, expiresAt: null, answeredAt: null }] }))).toEqual({ allowed: false, because: "open_request" });
    expect(documentRequestAllowed(facts({ requests: [past("answered", 3)] }))).toEqual({ allowed: false, because: "cooling_down" });
    expect(documentRequestAllowed(facts({ requests: [past("expired", 6)] }))).toEqual({ allowed: false, because: "cooling_down" });
    // Still open by status, past its date: expired as far as asking again goes.
    expect(documentRequestAllowed(facts({ requests: [past("open", 2)] }))).toEqual({ allowed: false, because: "cooling_down" });
    expect(documentRequestAllowed(facts({ requests: [past("expired", 8), past("answered", 9)] }))).toEqual({ allowed: true });
    expect(documentRequestAllowed(facts({ requests: [past("open", 8)] }))).toEqual({ allowed: true });
    expect(documentRequestAllowed(facts({ requests: [past("revoked", 30)] }))).toEqual({ allowed: false, because: "revoked" });
  });
});

describe("the billing email's domain (ER3, ER4)", () => {
  it("is the only part of the address kept, in lower case, and none for what is not an email", () => {
    expect(emailDomainOf("AP@Northstar.Example")).toBe("northstar.example");
    expect(emailDomainOf("billing+bills@mail.lumen.example")).toBe("mail.lumen.example");
    // An address in another script, kept as its ASCII form.
    expect(emailDomainOf(`ap@b${String.fromCharCode(0xfc)}cher.example`)).toBe("xn--bcher-kva.example");
    expect(emailDomainOf("no-at-sign")).toBeNull();
    expect(emailDomainOf("a@b@c.example")).toBeNull();
    expect(emailDomainOf("ap@")).toBeNull();
  });
});

describe("the one-time link (ER4)", () => {
  it("is vxu_ and 32 random bytes, of which only the SHA-256 is kept", () => {
    const { token, tokenHash } = generateDocumentToken(() => Buffer.alloc(32, 7));
    expect(token).toMatch(/^vxu_[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain(tokenHash);
    expect(documentTokenHash(token)).toBe(tokenHash);
    expect(documentTokenHash("vxw_" + token.slice(4))).toBeNull();
    expect(documentTokenHash(token + "x")).toBeNull();
    expect(documentTokenHash("")).toBeNull();
    expect(documentRequestUrl("https://www.vestiarion.xyz", token)).toBe(`https://www.vestiarion.xyz/documents/${token}`);
  });

  it("is a new one each time", () => {
    expect(generateDocumentToken().token).not.toBe(generateDocumentToken().token);
  });
});

describe("what the vendor may send (ER5)", () => {
  const bytes = (...values: number[]) => new Uint8Array([...values, 0, 0, 0, 0]);

  it("knows a PDF, a PNG and a JPEG by their first bytes, and nothing else", () => {
    expect(sniffDocumentType(new TextEncoder().encode("%PDF-1.7\n..."))).toBe("application/pdf");
    expect(sniffDocumentType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffDocumentType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffDocumentType(new TextEncoder().encode("<html><script>"))).toBeNull();
    expect(sniffDocumentType(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(sniffDocumentType(bytes(0x50, 0x4b, 0x03, 0x04))).toBeNull();
    expect(sniffDocumentType(new Uint8Array([]))).toBeNull();
  });

  it("takes an optional purchase order and note, trimmed, within their limits", () => {
    expect(readDocumentFields({ poReference: "  PO-4410 ", note: "" })).toEqual({ ok: true, poReference: "PO-4410", note: null });
    expect(readDocumentFields({ poReference: "", note: "Signed copy.\r\nThanks" })).toEqual({ ok: true, poReference: null, note: "Signed copy.\nThanks" });
    expect(readDocumentFields({ poReference: "P".repeat(101), note: "" })).toMatchObject({ ok: false, field: "poReference" });
    expect(readDocumentFields({ poReference: `PO${String.fromCharCode(0)}1`, note: "" })).toMatchObject({ ok: false, field: "poReference" });
    // A purchase order has no use for a character that changes how the text around it reads: a direction override, a
    // zero-width space or joiner. A note keeps them, as emoji need the joiner.
    for (const code of [0x202e, 0x2066, 0x200b, 0x200d, 0xfeff]) {
      expect(readDocumentFields({ poReference: `PO-1${String.fromCharCode(code)}2`, note: "" }), code.toString(16)).toMatchObject({ ok: false, field: "poReference" });
    }
    expect(readDocumentFields({ poReference: "", note: `Thanks ${String.fromCodePoint(0x1f469, 0x200d, 0x1f4bc)}` })).toMatchObject({ ok: true });
    // Nor a link, which a member might open from the card or Add details.
    for (const po of ["PO-1 verify at https://evil.example/login", "see www.evil.example"]) {
      expect(readDocumentFields({ poReference: po, note: "" })).toMatchObject({ ok: false, field: "poReference" });
    }
    expect(readDocumentFields({ poReference: "PO-2026/0042 #3", note: "" })).toEqual({ ok: true, poReference: "PO-2026/0042 #3", note: null });
    expect(readDocumentFields({ poReference: "", note: "n".repeat(501) })).toMatchObject({ ok: false, field: "note" });
    expect(readDocumentFields({ poReference: "", note: `tab${String.fromCharCode(9)}here` })).toMatchObject({ ok: false, field: "note" });
  });

  it("refuses a line or paragraph separator inside a purchase order, and reads one in a note as a line break, as answer_document_request does", () => {
    // Postgres on glibc counts U+2028 and U+2029 as control characters, so the function would refuse what passed here,
    // and the vendor would see only a generic failure, every time.
    for (const code of [0x2028, 0x2029]) {
      const char = String.fromCharCode(code);
      expect(readDocumentFields({ poReference: `PO-4410${char}rev B`, note: "" }), code.toString(16)).toEqual({
        ok: false,
        field: "poReference",
        message: expect.stringContaining("one line"),
      });
      expect(readDocumentFields({ poReference: "", note: `First line.${char}Second line.${char}` }), code.toString(16)).toEqual({
        ok: true,
        poReference: null,
        note: "First line.\nSecond line.",
      });
    }
  });
});

describe("what a bill's card says (ER3, ER4, ER6)", () => {
  it("says what Vestiarion would ask, in shadow", () => {
    expect(documentRequestLine({ state: "would_ask", missing: ["purchase_order"] }, "Northstar Studio")).toBe(
      "Vestiarion would ask Northstar Studio for the purchase order. Turn on vendor requests in Settings to send it."
    );
  });

  it("says when it asked and when the link expires", () => {
    expect(
      documentRequestLine({ state: "asked", missing: ["purchase_order", "goods_receipt"], sentAt: "2026-10-23T09:00:00Z", expiresAt: "2026-11-06T09:00:00Z" }, "Northstar Studio")
    ).toBe("Asked Northstar Studio for the purchase order and the goods receipt on Oct 23; the link expires Nov 6.");
  });

  it("says when the vendor sent a document", () => {
    expect(documentRequestLine({ state: "answered", missing: ["purchase_order"], answeredAt: "2026-10-24T15:30:00Z" }, "Northstar Studio")).toBe("Northstar Studio sent a document on Oct 24.");
  });

  it("says a link expired without an answer", () => {
    expect(documentRequestLine({ state: "expired", missing: ["goods_receipt"], sentAt: "2026-10-01T09:00:00Z", expiresAt: "2026-10-15T09:00:00Z" }, "Northstar Studio")).toBe(
      "Asked Northstar Studio for the goods receipt on Oct 1; the link expired Oct 15 with no answer."
    );
  });
});

describe("what a bill's card says of the check (document checks DK13)", () => {
  const VENDOR = "Northstar Studio";
  const matched = (over: Partial<Extract<DocumentCheckView, { outcome: "matched" }>> = {}): DocumentCheckView => ({
    outcome: "matched",
    po: "PO-2215",
    added: false,
    shadowLeftPo: false,
    ...over,
  });

  it("takes a member's PDF of at most what the cycle reads", () => {
    expect(MAX_ATTACHED_DOCUMENT_BYTES).toBe(MAX_DOCUMENT_BYTES);
  });

  it("names who sent the document: the vendor through its link, or a member who attached it", () => {
    expect(documentRequestLine({ state: "answered", missing: ["purchase_order"], answeredAt: "2026-10-24T15:30:00Z", source: "vendor" }, VENDOR)).toBe(
      "Northstar Studio sent a document on Oct 24."
    );
    expect(documentRequestLine({ state: "answered", missing: ["purchase_order"], answeredAt: "2026-10-25T08:00:00Z", source: "member" }, VENDOR)).toBe(
      "A member attached Northstar Studio's document on Oct 25."
    );
  });

  it("says a document waits for the next cycle", () => {
    expect(documentCheckLine({ outcome: "pending" }, VENDOR, true)).toBe("Vestiarion checks it against the bill at its next cycle, usually within a minute.");
  });

  it("says what a match added, and who approves the payment, as the bill's goods stand now", () => {
    expect(documentCheckLine(matched({ added: true }), VENDOR, true)).toBe(
      "Vendor, amount and purchase order PO-2215 match the bill. Vestiarion added the purchase order and checked the bill again. A person approves the payment: the agent does not pay it on its own."
    );
    expect(documentCheckLine(matched({ added: true }), VENDOR, false)).toBe(
      "Vendor, amount and purchase order PO-2215 match the bill. Vestiarion added the purchase order. Only your team can mark the goods received: do it in Add details once you have them, and a person then approves the payment."
    );
  });

  it("says a match in shadow left the bill as it is", () => {
    expect(documentCheckLine(matched({ shadowLeftPo: true }), VENDOR, true)).toBe(
      "Vendor, amount and purchase order PO-2215 match the bill. Vendor requests are in shadow, so the bill was left as it is: add the purchase order yourself."
    );
    expect(documentCheckLine(matched({ shadowLeftPo: true }), VENDOR, false)).toBe(
      "Vendor, amount and purchase order PO-2215 match the bill. Vendor requests are in shadow, so the bill was left as it is: add the purchase order yourself."
    );
  });

  it("says a match that added nothing, with the goods still to mark received", () => {
    expect(documentCheckLine(matched(), VENDOR, true)).toBe("Vendor, amount and purchase order PO-2215 match the bill.");
    expect(documentCheckLine(matched({ po: null }), VENDOR, true)).toBe("Vendor and amount match the bill.");
    expect(documentCheckLine(matched(), VENDOR, false)).toBe(
      "Vendor, amount and purchase order PO-2215 match the bill. Only your team can mark the goods received: do it in Add details once you have them."
    );
    expect(documentCheckLine(matched({ po: null }), VENDOR, false)).toBe(
      "Vendor and amount match the bill. Only your team can mark the goods received: do it in Add details once you have them."
    );
  });

  it("gives the reason of a mismatch, an unreadable file and a skip", () => {
    expect(documentCheckLine({ outcome: "mismatched", reason: "The document says 8.50 USDC; the bill says 8.00 USDC." }, VENDOR, true)).toBe(
      "The document says 8.50 USDC; the bill says 8.00 USDC. The bill still waits: check it with Northstar Studio, or add the details yourself."
    );
    expect(documentCheckLine({ outcome: "unreadable", reason: "It is an image. Only a PDF with its text is checked." }, VENDOR, true)).toBe(
      "Vestiarion could not check it. It is an image. Only a PDF with its text is checked. Open it, and add the details yourself."
    );
    expect(documentCheckLine({ outcome: "skipped", reason: "It was not checked: the bill no longer waited for a document." }, VENDOR, true)).toBe(
      "It was not checked: the bill no longer waited for a document."
    );
  });
});
