import type { InvoiceDraftRead } from "../invoice-document/draft";
import { lateFeeFieldsOf } from "../invoice-document/normalize";
import { documentPayToOf } from "../invoice-document/provenance";
import type { ShownRead } from "./list";

/**
 * What the review list shows of a read (email invoices design E7, reader follow-up F6): the fields, what to check, and
 * whether the sender is the counterparty's known one; the form that finishes it starts from these. Shared by an emailed
 * invoice and a file from Google Drive (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD6), which has
 * no sender to know.
 */
export function shownOf(read: InvoiceDraftRead, knownSender: boolean): ShownRead {
  const { draft } = read;
  return {
    counterpartyName: read.counterpartyName,
    vendorName: draft.vendorName,
    amount: draft.amount,
    currency: draft.currency,
    dueDate: draft.dueDate,
    poReference: draft.poReference,
    invoiceNumber: draft.invoiceNumber,
    memo: draft.memo,
    warnings: read.warnings,
    modelNote: read.modelNote,
    reader: read.reader,
    knownSender,
    counterpartyId: draft.counterpartyId,
    earlyPayDiscountPct: draft.earlyPayDiscountPct,
    discountDeadline: draft.discountDeadline,
    ...lateFeeFieldsOf(draft),
    document: { kind: read.document.kind, sha256: read.document.sha256 },
    ...(documentPayToOf(draft) ? { payTo: documentPayToOf(draft) as string } : {}),
  };
}
