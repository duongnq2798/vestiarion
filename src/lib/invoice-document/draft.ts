import type { DecisionMode } from "../agent/decide";
import { db, unwrap } from "../dal";
import { extractInvoice } from "./extract";
import { matchCounterparty, type MatchableCounterparty } from "./match";
import { normalizeExtraction, type InvoiceDraft, type NotFoundField } from "./normalize";
import { readDocument, type DocumentInput } from "./read";

/** What one invoice document was read as: a draft of the invoice form, and what a member should check in it. */
export interface InvoiceDraftRead {
  draft: InvoiceDraft & { counterpartyId: string | null };
  /** The matched counterparty's name, or null when none matched. */
  counterpartyName: string | null;
  warnings: string[];
  notFound: NotFoundField[];
  /** The model's own note on what to check, or null. */
  modelNote: string | null;
  reader: DecisionMode;
  document: { kind: "pdf" | "email" | "text"; sha256: string; truncated: boolean };
}

/**
 * Reads an invoice document into a draft (invoice from a document D1–D9): the text, the model's reading checked
 * against it, the total line read by rule against the model's total, and the match to the workspace's counterparties.
 * Nothing is written. Shared by **From a document** and the Telegram bot (Telegram bot design R10); each keeps its own
 * authorization, size check and read limit. Runs inside the organization's scope; throws `DocumentReadError` for a
 * document it cannot read.
 */
export async function readInvoiceDraft(input: DocumentInput, today: string): Promise<InvoiceDraftRead> {
  const document = await readDocument(input);
  const counterparties = unwrap(await db().from("counterparties").select("id, name, role, address").order("name")) as MatchableCounterparty[];

  const { raw, reader, reference } = await extractInvoice(document.text, today);
  const { fields, notFound, notes, modelNote } = normalizeExtraction(raw, document.text);
  // The total line, read by rule, against the model's total: both are in the document, so neither is blanked,
  // but a member should know when they differ (review I1).
  const ruled = reader === "heuristic" ? null : normalizeExtraction(reference, document.text).fields.amount;
  const totals =
    ruled !== null && fields.amount !== null && Number(ruled) !== Number(fields.amount)
      ? [`The total line reads ${ruled}, but the model read ${fields.amount}. Check the amount against the invoice.`]
      : [];
  const match = matchCounterparty(fields, counterparties);
  const matched = counterparties.find((counterparty) => counterparty.id === match.counterpartyId);

  return {
    draft: { ...fields, counterpartyId: match.counterpartyId },
    counterpartyName: matched?.name ?? null,
    warnings: [...totals, ...match.warnings, ...notes, ...(document.truncated ? ["Only the first 20,000 characters were read."] : [])],
    notFound,
    modelNote,
    reader,
    document: { kind: document.kind, sha256: document.sha256, truncated: document.truncated },
  };
}
