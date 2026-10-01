"use server";

import "server-only";

import type { DecisionMode } from "@/lib/agent/decide";
import { authorize } from "@/lib/auth/authorize";
import { db, unwrap } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { extractInvoice } from "@/lib/invoice-document/extract";
import { matchCounterparty, type MatchableCounterparty } from "@/lib/invoice-document/match";
import { normalizeExtraction, type InvoiceDraft, type NotFoundField } from "@/lib/invoice-document/normalize";
import { DocumentReadError, MAX_DOCUMENT_BYTES, readDocument, type DocumentInput } from "@/lib/invoice-document/read";
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
  reader?: DecisionMode;
  document?: { kind: "pdf" | "text"; sha256: string; truncated: boolean };
  /** Changes on every read, so the form below remounts with the new values. */
  nonce?: number;
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
  return inOrg(auth, async () => {
    try {
      // The size is checked before the bytes are read, and the limit before the model is called.
      const source = chosen(formData);
      if (!takeDocumentReadToken(auth.membership.orgId)) {
        return { ok: false, message: "That is five invoices read this minute. Try again in a few seconds." };
      }
      const document = await readDocument(await documentInput(source));
      const counterparties = unwrap(await db().from("counterparties").select("id, name, role, address").order("name")) as MatchableCounterparty[];

      const { raw, reader } = await extractInvoice(document.text, new Date().toISOString().slice(0, 10));
      const { fields, notFound, notes } = normalizeExtraction(raw, document.text);
      const match = matchCounterparty(fields, counterparties);
      const matched = counterparties.find((counterparty) => counterparty.id === match.counterpartyId);

      return {
        ok: true,
        message: `Read the invoice${matched ? ` from ${matched.name}` : ""}. Check every field before adding it.`,
        draft: { ...fields, counterpartyId: match.counterpartyId },
        warnings: [...match.warnings, ...notes, ...(document.truncated ? ["Only the first 20,000 characters were read."] : [])],
        notFound,
        reader,
        document: { kind: document.kind, sha256: document.sha256, truncated: document.truncated },
        nonce: Date.now(),
      };
    } catch (error) {
      if (error instanceof DocumentReadError) return { ok: false, message: error.message };
      console.error("invoice document read failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "The invoice could not be read. Try again in a moment." };
    }
  });
}
