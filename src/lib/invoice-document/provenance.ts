import type { DecisionMode } from "@/lib/agent/decide";

/**
 * What an invoice's ledger entry records about the document it was read from
 * (invoice from a document D8): the document's hash and kind, the reader, and
 * which fields the member changed from what was read. The document itself is
 * never stored. The fields arrive as hidden inputs on the invoice form; they
 * describe the member's own edits and never decide anything about money, so
 * a malformed set is dropped rather than refused.
 *
 * It also keeps the address the document asked to be paid to, when it named one
 * (invoice pay-to hold IP1). That one only ever holds a payment back: the agent
 * pays the address on file, and holds a payment whose document asked for another.
 */

export const DOCUMENT_FIELDS = ["amount", "currency", "dueDate", "poReference", "earlyPayDiscountPct", "discountDeadline", "memo", "counterpartyId"] as const;
export type DocumentField = (typeof DOCUMENT_FIELDS)[number];

export interface DocumentProvenance {
  kind: "pdf" | "email" | "text";
  sha256: string;
  reader: DecisionMode;
  changed: DocumentField[];
  /** The 0x address the document asked to be paid to, as it writes it (IP1); absent when it named none. */
  payTo?: string;
}

const PAY_TO_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The address a reading asked to be paid to (`payToAddress`), or none: only a 0x address, which the reader kept only when
 * the document's text has it.
 */
export function documentPayToOf(read: { payToAddress?: unknown } | null | undefined): string | null {
  const address = typeof read?.payToAddress === "string" ? read.payToAddress.trim() : "";
  return PAY_TO_ADDRESS.test(address) ? address : null;
}

const READERS: readonly DecisionMode[] = ["anthropic", "openai", "deepseek", "heuristic"];
const NUMERIC: ReadonlySet<DocumentField> = new Set(["amount", "earlyPayDiscountPct"]);

/** The fields as a member submitted them, each a string or null. */
export type Submitted = Record<DocumentField, string | null>;

function blank(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function same(field: DocumentField, read: string | null, submitted: string | null): boolean {
  if (read === null || submitted === null) return read === submitted;
  // "10.5" and "10.50" are the same amount, written two ways.
  if (NUMERIC.has(field)) return Number(read) === Number(submitted);
  return read === submitted;
}

/** Whether a reader named in stored or submitted data is one Vestiarion has. */
export function isReader(value: unknown): value is DecisionMode {
  return typeof value === "string" && READERS.includes(value as DecisionMode);
}

/** The fields a member changed from what was read: an empty value and a missing one are the same, as are 10.5 and 10.50. */
export function changedFields(read: Partial<Record<DocumentField, unknown>>, submitted: Submitted): DocumentField[] {
  return DOCUMENT_FIELDS.filter((field) => !same(field, blank(read[field]), submitted[field]));
}

export function documentProvenance(formData: FormData, submitted: Submitted): DocumentProvenance | null {
  const sha256 = formData.get("documentSha256");
  const kind = formData.get("documentKind");
  const reader = formData.get("documentReader");
  const readJson = formData.get("documentRead");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (kind !== "pdf" && kind !== "email" && kind !== "text") return null;
  if (!isReader(reader)) return null;
  if (typeof readJson !== "string") return null;

  let read: unknown;
  try {
    read = JSON.parse(readJson);
  } catch {
    return null;
  }
  if (typeof read !== "object" || read === null || Array.isArray(read)) return null;
  const payTo = documentPayToOf(read as Record<string, unknown>);
  return { kind, sha256, reader, changed: changedFields(read as Record<string, unknown>, submitted), ...(payTo ? { payTo } : {}) };
}
