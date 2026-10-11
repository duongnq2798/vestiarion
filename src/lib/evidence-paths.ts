/**
 * Where a payment's evidence lives (docs/superpowers/specs/2026-10-10-evidence-chain-design.md E1, E6): one page per
 * payable or milestone, named by the record, never by a payment attempt. Pure and free of tenant data, so a card can
 * link the page without importing the reader.
 */

/** The records with evidence: a payable (`invoice`) and a contractor milestone. */
export type EvidenceRecordKind = "invoice" | "milestone";

/** A workspace path, for `orgHref`: `/evidence/invoice/<id>`. */
export function evidencePath(kind: EvidenceRecordKind, id: string): string {
  return `/evidence/${kind}/${id}`;
}

/** The link's words on a card (E6): why a paid one was paid, and the chain so far for any other. */
export function evidenceLinkLabel(paid: boolean): string {
  return paid ? "Why it was paid" : "Evidence so far";
}

/** The decision trail's last line (E6). */
export const WHOLE_CHAIN = "The whole chain, from purchase order to receipt";
