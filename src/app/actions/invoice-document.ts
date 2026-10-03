"use server";

import "server-only";

import type { DecisionMode } from "@/lib/agent/decide";
import { authorize } from "@/lib/auth/authorize";
import { inOrg } from "@/lib/dal/scope";
import { readInvoiceDraft } from "@/lib/invoice-document/draft";
import type { InvoiceDraft, NotFoundField } from "@/lib/invoice-document/normalize";
import { DocumentReadError, MAX_DOCUMENT_BYTES, type DocumentInput } from "@/lib/invoice-document/read";
import { takeDocumentReadToken } from "@/lib/rate-limit";

/**
 * An invoice document read into a draft of the invoice form (invoice from a
 * document D1–D9). Nothing is written: the member checks the draft and adds
 * it through `createInvoiceAction`, like any invoice typed in.
 */

export interface DocumentReadResult {
  ok: boolean;
  message: string;
  draft?: InvoiceDraft & { counterpartyId: string | null };
  warnings?: string[];
  notFound?: NotFoundField[];
  /** The model's own note on what to check, or null. */
  modelNote?: string | null;
  reader?: DecisionMode;
  document?: { kind: "pdf" | "email" | "text"; sha256: string; truncated: boolean };
  /** Changes on every read, so the form below remounts with the new values. */
  nonce?: number;
  /** On a refusal about the file chosen: let it go, so text pasted next is what is read (review I3). */
  clearFile?: boolean;
}

/** The file chosen, when there is one, or else the text pasted. A file over the limit is refused before its bytes are read. */
function chosen(formData: FormData): File | string {
  const file = formData.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_DOCUMENT_BYTES) throw new DocumentReadError("too_large");
    return file;
  }
  const text = formData.get("text");
  return typeof text === "string" ? text : "";
}

async function documentInput(source: File | string): Promise<DocumentInput> {
  if (typeof source === "string") return { text: source };
  return { bytes: new Uint8Array(await source.arrayBuffer()), name: source.name, type: source.type };
}

export async function readInvoiceDocumentAction(_previous: DocumentReadResult, formData: FormData): Promise<DocumentReadResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const file = formData.get("file");
  const fromFile = file instanceof File && file.size > 0;
  return inOrg(auth, async () => {
    try {
      // The size is checked before the bytes are read, and the limit before the model is called.
      const source = chosen(formData);
      if (!takeDocumentReadToken(auth.membership.orgId)) {
        return { ok: false, message: "That is five invoices read this minute. Try again in a few seconds." };
      }
      const read = await readInvoiceDraft(await documentInput(source), new Date().toISOString().slice(0, 10));

      return {
        ok: true,
        message: `Read the invoice${read.counterpartyName ? ` from ${read.counterpartyName}` : ""}. Check every field before adding it.`,
        draft: read.draft,
        warnings: read.warnings,
        notFound: read.notFound,
        modelNote: read.modelNote,
        reader: read.reader,
        document: read.document,
        nonce: Date.now(),
      };
    } catch (error) {
      if (error instanceof DocumentReadError) return { ok: false, message: error.message, clearFile: fromFile };
      console.error("invoice document read failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "The invoice could not be read. Try again in a moment." };
    }
  });
}
