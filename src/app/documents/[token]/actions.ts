"use server";

import "server-only";

import { headers } from "next/headers";
import { after } from "next/server";
import { startDocumentUpload, submitDocument, type DocumentSubmission, type UploadStart } from "@/lib/document-requests/intake";
import { DOCUMENT_LINK_INVALID as INVALID_LINK } from "@/lib/document-requests/rules";

/**
 * The vendor's page behind a document request's link (docs/superpowers/specs/2026-10-23-document-requests-design.md ER5).
 * No session: the one-time link is the vendor's only credential. Nothing from a failure reaches the vendor but a fixed
 * sentence. The owners' and admins' email goes after the vendor has its answer. Both calls are rate-limited per address
 * and per link; the address is the first one the request was forwarded for.
 */

export interface DocumentUploadStartResult {
  ok: boolean;
  message: string;
  /** Where the browser puts the file, once it may. */
  url?: string;
}

export interface DocumentSubmitResult {
  ok: boolean;
  message: string;
  /** The field the refusal is about, so the form marks it. */
  field?: "file" | "poReference" | "note";
}

const TRY_AGAIN = "That did not work. Try again in a moment.";
const FILE_MESSAGES = {
  no_file: "Choose the file to send.",
  too_large: "The file is over 10 MB. Send a smaller copy.",
  file_type: "Send a PDF, PNG or JPEG. This file is none of those.",
  busy: "Too many tries. Wait a minute, then try again.",
  unavailable: TRY_AGAIN,
} as const;

async function clientAddress(): Promise<string> {
  const list = await headers();
  return list.get("x-forwarded-for")?.split(",")[0]?.trim() || list.get("x-real-ip") || "unknown";
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** An upload address for the file the vendor chose: only for one of the kinds and the size the page takes. */
export async function startDocumentUploadAction(token: string, size: number, type: string): Promise<DocumentUploadStartResult> {
  try {
    const started: UploadStart = await startDocumentUpload(typeof token === "string" ? token : "", { size: Number(size), type: String(type) }, await clientAddress());
    if (started.ok) return { ok: true, message: "", url: started.url };
    if (started.reason === "invalid_link") return { ok: false, message: INVALID_LINK };
    return { ok: false, message: FILE_MESSAGES[started.reason] };
  } catch (error) {
    console.error("document upload not started", error instanceof Error ? error.message : "unknown error");
    return { ok: false, message: TRY_AGAIN };
  }
}

/** The vendor sends the file it uploaded, with the purchase order number and a note if it gave them. */
export async function submitDocumentAction(_previous: DocumentSubmitResult, formData: FormData): Promise<DocumentSubmitResult> {
  try {
    const result: DocumentSubmission = await submitDocument(
      formString(formData, "token"),
      { poReference: formString(formData, "poReference"), note: formString(formData, "note") },
      await clientAddress(),
      { defer: (work) => after(work) }
    );
    if (result.ok) return { ok: true, message: `Thank you. ${result.orgName} has been told, and has your document. Nothing else is needed from you.` };
    if (result.reason === "invalid") return { ok: false, message: result.message, field: result.field };
    if (result.reason === "invalid_link") return { ok: false, message: INVALID_LINK };
    if (result.reason === "failed_check") return { ok: false, message: TRY_AGAIN };
    return { ok: false, message: FILE_MESSAGES[result.reason], ...(result.reason === "busy" || result.reason === "unavailable" ? {} : { field: "file" as const }) };
  } catch (error) {
    console.error("document not taken", error instanceof Error ? error.message : "unknown error");
    return { ok: false, message: TRY_AGAIN };
  }
}
