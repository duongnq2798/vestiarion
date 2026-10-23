import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The vendor's page behind a document request's link (docs/superpowers/specs/2026-10-23-document-requests-design.md ER5):
 * an open request names the business, the vendor's own invoice number, its amount and due date, and what is missing,
 * with the form; any other link shows one sentence and names no one; the page is kept out of search.
 */

vi.mock("server-only", () => ({}));
const { previewMock } = vi.hoisted(() => ({ previewMock: vi.fn() }));
vi.mock("@/lib/document-requests/intake", () => ({ previewDocumentRequest: previewMock }));
vi.mock("@/app/documents/[token]/actions", () => ({ startDocumentUploadAction: vi.fn(), submitDocumentAction: vi.fn() }));

const { default: DocumentRequestPage, metadata } = await import("@/app/documents/[token]/page");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const open = async (token = "vxu_x") => renderToStaticMarkup(await DocumentRequestPage({ params: Promise.resolve({ token }) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the vendor's page (ER5)", () => {
  it("names the business, the vendor's invoice, its amount and due date, and what is missing, with the form", async () => {
    previewMock.mockResolvedValueOnce({
      orgName: "Pinecrest Studio",
      vendorName: "Northstar Studio",
      reference: "INV-2215",
      amount: 1250,
      currency: "USDC",
      dueDate: "2026-10-30T12:00:00+00:00",
      missing: ["purchase_order", "goods_receipt"],
      expiresAt: "2026-11-06T09:00:00+00:00",
    });
    const page = text(await open());
    expect(page).toContain("Pinecrest Studio needs the purchase order and the goods receipt");
    expect(page).toContain("INV-2215");
    expect(page).toContain("1,250.00 USDC");
    expect(page).toContain("Oct 30, 2026");
    expect(page).toContain("One PDF, PNG or JPEG, up to 10 MB.");
    expect(page).toContain("Purchase order number");
    expect(page).toContain("This link takes one document, until Nov 6, 2026 (UTC).");
    expect(page).toContain("Send the document");
  });

  it("shows one sentence, naming no one, for an expired, answered, revoked or unknown link", async () => {
    previewMock.mockResolvedValueOnce(null);
    const page = text(await open());
    expect(page).toContain("This link is no longer valid. If the business still needs a document, ask them for a new link.");
    expect(page).not.toContain("Send the document");
  });

  it("says only that it could not load when the lookup fails", async () => {
    previewMock.mockRejectedValueOnce(new Error("relation does not exist"));
    expect(text(await open())).toContain("This page could not load. Try again in a moment.");
  });

  it("is kept out of search", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
