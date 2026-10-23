// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The vendor's form behind a document request's link (docs/superpowers/specs/2026-10-23-document-requests-design.md ER5):
 * the file is known by its first bytes, not its name, so a PDF saved with no extension, which the browser gives no type,
 * still gets its upload address, and is put to storage as what it is. The server checks the bytes again when it is sent.
 */

const { startMock, submitMock } = vi.hoisted(() => ({ startMock: vi.fn(), submitMock: vi.fn() }));
vi.mock("@/app/documents/[token]/actions", () => ({ startDocumentUploadAction: startMock, submitDocumentAction: submitMock }));

import { DocumentUploadForm } from "@/components/document-requests/DocumentUploadForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UPLOAD = "https://tests.supabase.invalid/storage/v1/object/upload/sign/documents/x?token=t";
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF");
const REQUEST = { orgName: "Pinecrest Studio", vendorName: "Northstar Studio", reference: "INV-2215", amount: "1,250.00 USDC", dueOn: "Oct 30, 2026", until: "Nov 6, 2026", missing: ["purchase_order" as const] };

let container: HTMLDivElement;
let root: Root;
const put = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response("{}", { status: 200 }));

beforeEach(() => {
  startMock.mockReset().mockResolvedValue({ ok: true, message: "", url: UPLOAD });
  submitMock.mockReset().mockResolvedValue({ ok: true, message: "Thank you." });
  put.mockClear();
  vi.stubGlobal("fetch", put);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<DocumentUploadForm token="vxu_x" request={REQUEST} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function send(file: File) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const form = container.querySelector("form");
  if (!form) throw new Error("no form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the vendor's form (ER5)", () => {
  it("knows a file the browser gives no type, such as a PDF saved with no extension, by its first bytes", async () => {
    await send(new File([PDF], "PO-1234", { type: "" }));
    expect(startMock).toHaveBeenCalledWith("vxu_x", PDF.byteLength, "application/pdf");
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toBe(UPLOAD);
    expect(new Headers(put.mock.calls[0][1]?.headers).get("content-type")).toBe("application/pdf");
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it("goes by the bytes over the name, and leaves the refusal of a file that is none of the three to the server", async () => {
    startMock.mockResolvedValueOnce({ ok: false, message: "Send a PDF, PNG or JPEG. This file is none of those." });
    const page = new TextEncoder().encode("<html></html>");
    await send(new File([page], "notes.txt", { type: "text/plain" }));
    expect(startMock).toHaveBeenLastCalledWith("vxu_x", page.byteLength, "text/plain");
    expect(container.textContent).toContain("Send a PDF, PNG or JPEG. This file is none of those.");
    expect(put).not.toHaveBeenCalled();
    await send(new File([PDF], "scan.png", { type: "image/png" }));
    expect(startMock).toHaveBeenLastCalledWith("vxu_x", PDF.byteLength, "application/pdf");
    expect(new Headers(put.mock.calls[0][1]?.headers).get("content-type")).toBe("application/pdf");
  });
});
