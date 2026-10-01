import type { DecisionMode } from "@/lib/agent/decide";

/**
 * What an invoice's ledger entry records about the document it was read from
 * (invoice from a document D8): the document's hash and kind, the reader, and
 * which fields the member changed from what was read. The document itself is
 * never stored. The fields arrive as hidden inputs on the invoice form; they
 * describe the member's own edits and never decide anything about money, so
 * a malformed set is dropped rather than refused.
 */

export const DOCUMENT_FIELDS = ["amount", "currency", "dueDate", "poReference", "earlyPayDiscountPct", "discountDeadline", "memo", "counterpartyId"] as const;
export type DocumentField = (typeof DOCUMENT_FIELDS)[number];

export interface DocumentProvenance {
  kind: "pdf" | "text";
  sha256: string;
  reader: DecisionMode;
  changed: DocumentField[];
}

const READERS: readonly DecisionMode[] = ["anthropic", "openai", "deepseek", "heuristic"];
const NUMERIC: ReadonlySet<DocumentField> = new Set(["amount", "earlyPayDiscountPct"]);

type Submitted = Record<DocumentField, string | null>;

function blank(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function same(field: DocumentField, read: string | null, submitted: string | null): boolean {
  if (read === null || submitted === null) return read === submitted;
  // "10.5" and "10.50" are the same amount, written two ways.
  if (NUMERIC.has(field)) return Number(read) === Number(submitted);
  return read === submitted;
}

export function documentProvenance(formData: FormData, submitted: Submitted): DocumentProvenance | null {
  const sha256 = formData.get("documentSha256");
  const kind = formData.get("documentKind");
  const reader = formData.get("documentReader");
  const readJson = formData.get("documentRead");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (kind !== "pdf" && kind !== "text") return null;
  if (typeof reader !== "string" || !READERS.includes(reader as DecisionMode)) return null;
  if (typeof readJson !== "string") return null;

  let read: unknown;
  try {
    read = JSON.parse(readJson);
  } catch {
    return null;
  }
  if (typeof read !== "object" || read === null || Array.isArray(read)) return null;

  const values = read as Record<string, unknown>;
  const changed = DOCUMENT_FIELDS.filter((field) => !same(field, blank(values[field]), submitted[field]));
  return { kind, sha256, reader: reader as DecisionMode, changed };
}
