import { randomUUID } from "node:crypto";
import { runCycleSoon } from "../agent/cycle-soon";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { DocumentReadError } from "../invoice-document/read";
import { changedFields, isReader, type DocumentProvenance, type Submitted } from "../invoice-document/provenance";
import type { InvoiceInput } from "../invoices/create";
import { captureRequestHash, isPicture, readCapture, type CaptureInput } from "../invoice-drafts/capture";
import { draftDuplicates } from "../invoice-drafts/duplicates";
import { columnsOfEdit, type DraftEdit, type DraftRow } from "../invoice-drafts/model";
import { billsOf, draftById, draftByKey, draftOfConnection, draftsNaming, insertDraft, invoiceExists, moveDraft, unsentDraftCount } from "../invoice-drafts/store";
import { cycleEventOf, type Actor } from "./actor";
import { addInvoice } from "./invoices";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * A draft the Chrome extension captured (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C1-C8). The
 * extension captures one, edits it and sends it for review, through the connection a member consented to; in the
 * console an owner or admin adds it as a bill, through `addInvoice` like every other bill, or discards it. Nothing
 * here pays, approves or adds an invoice from the extension: its surface may run `invoice_draft.capture`, `.edit` and
 * `.send` only. Every command runs inside the workspace's scope; before migration 0121 a draft command throws
 * `CaptureNotSetUpError`, which the extension's routes answer as not set up.
 */

const ALREADY_DECIDED = "This draft was already decided.";
/** The most drafts never sent one connection keeps (M8). */
export const MAX_UNSENT_DRAFTS = 50;
/** Refusals of `addInvoice` that wrote nothing: the draft can go back for review as it was. */
const NOTHING_WRITTEN: ReadonlySet<string> = new Set(["counterparty_not_found", "forbidden", "surface"]);

/**
 * Captures a draft from the extension (C2, C19): the same `Idempotency-Key` and the same capture answer the draft
 * already made, another capture with that key is refused, and anything else is read by the reader into a new draft,
 * still `draft`, after taking one of the reader's reads. The caller has already checked the size.
 */
export async function captureInvoiceDraft(
  actor: Actor,
  input: {
    connectionId: string;
    idempotencyKey: string;
    capture: CaptureInput;
    today: string;
    /** Takes one of the reader's reads (five a minute per workspace); false when none is left. A picture takes none. */
    allowRead?: () => boolean;
  }
): Promise<CommandOutcome<{ draft: DraftRow; replayed: boolean }>> {
  const refusal = gate(actor, "invoice_draft.capture");
  if (refusal) return refusal;
  const requestHash = captureRequestHash(input.capture);
  const replay = (existing: DraftRow): CommandOutcome<{ draft: DraftRow; replayed: boolean }> =>
    existing.request_sha256 === requestHash
      ? done("Captured.", { draft: existing, replayed: true })
      : refused("idempotency_conflict", "This Idempotency-Key was already used for another capture.");

  const existing = await draftByKey(input.connectionId, input.idempotencyKey);
  if (existing) return replay(existing);
  if ((await unsentDraftCount(input.connectionId, MAX_UNSENT_DRAFTS)) >= MAX_UNSENT_DRAFTS) {
    return refused(
      "too_many_drafts",
      `This connection already has ${MAX_UNSENT_DRAFTS} drafts that were never sent. Send the ones you need first: a draft not sent is deleted within 7 days of its capture.`
    );
  }

  const picture = input.capture.source === "file" && isPicture(input.capture.bytes);
  if (!picture && input.allowRead && !input.allowRead()) {
    return refused("rate_limited", "That is five invoices read this minute. Try again in a few seconds.");
  }
  let read: Awaited<ReturnType<typeof readCapture>>;
  try {
    read = await readCapture(input.capture, input.today);
  } catch (error) {
    if (error instanceof DocumentReadError) return refused("unreadable", error.message);
    throw error;
  }
  const inserted = await insertDraft({
    state: "draft",
    source: input.capture.source,
    document_kind: read.document.kind,
    document_sha256: read.document.sha256,
    supplier_name: read.fields.supplierName,
    invoice_number: read.fields.invoiceNumber,
    amount: read.fields.amount,
    currency: read.fields.currency,
    invoice_date: read.fields.invoiceDate,
    due_date: read.fields.dueDate,
    po_reference: read.fields.poReference,
    memo: read.fields.memo,
    read: read.read,
    raw_text: read.rawText,
    counterparty_id: read.counterpartyId,
    connection_id: input.connectionId,
    idempotency_key: input.idempotencyKey,
    request_sha256: requestHash,
    captured_by: actor.userId,
  });
  if ("clash" in inserted) {
    const raced = await draftByKey(input.connectionId, input.idempotencyKey);
    return raced ? replay(raced) : refused("failed", TRY_AGAIN);
  }
  return done("Captured.", { draft: inserted.row, replayed: false });
}

/**
 * The person's edits in the extension, before it is sent (C4): only a draft this connection captured, still `draft`.
 * A sent draft is reviewed in the console and no longer changed from the extension.
 */
export async function editInvoiceDraft(
  actor: Actor,
  input: { draftId: string; connectionId: string; edit: DraftEdit }
): Promise<CommandOutcome<{ draft: DraftRow }>> {
  const refusal = gate(actor, "invoice_draft.edit");
  if (refusal) return refusal;
  const found = await draftOfConnection(input.draftId, input.connectionId);
  if (!found) return refused("not_found", "No draft with that id was captured through this connection.");
  if (found.state !== "draft") return refused("not_editable", "This draft was sent. It is reviewed in Vestiarion now.");
  const columns = columnsOfEdit(input.edit);
  // Another supplier is another counterparty: the console no longer starts from the one the reader matched (M8).
  if ("supplier_name" in columns && columns.supplier_name !== found.supplier_name) columns.counterparty_id = null;
  const moved = await moveDraft(input.draftId, "draft", columns, { connectionId: input.connectionId });
  if (moved) return done("Saved.", { draft: moved });
  return refused("not_editable", "This draft was sent. It is reviewed in Vestiarion now.");
}

/**
 * Sends a draft for review (C4, C8): `draft` to `sent`, once. It is still a draft: it waits on Bills & receivables
 * for a person. Sending it again answers it as it is.
 */
export async function sendInvoiceDraft(actor: Actor, input: { draftId: string; connectionId: string }): Promise<CommandOutcome<{ draft: DraftRow }>> {
  const refusal = gate(actor, "invoice_draft.send");
  if (refusal) return refusal;
  const sent = await moveDraft(input.draftId, "draft", { state: "sent", sent_at: new Date().toISOString() }, { connectionId: input.connectionId });
  if (!sent) {
    const found = await draftOfConnection(input.draftId, input.connectionId);
    if (!found) return refused("not_found", "No draft with that id was captured through this connection.");
    return done("Already sent.", { draft: found });
  }
  await appendLedgerEntryBestEffort(actor.orgId, {
    actor: "human",
    domain: "ap",
    action: "invoice_draft_captured",
    summary: "Sent an invoice captured with the Chrome extension for review",
    detail: {
      by: actor.userId,
      draftId: sent.id,
      source: sent.source,
      document: sent.document_kind && sent.document_sha256 ? { kind: sent.document_kind, sha256: sent.document_sha256 } : null,
      connectionId: input.connectionId,
    },
  });
  return done("Sent for review.", { draft: sent });
}

/** What the bill's entry says of the document it was captured from: its kind, hash, reader, and the fields changed (C6). */
function capturedProvenance(draft: DraftRow, invoice: InvoiceInput): DocumentProvenance | null {
  const kind = draft.document_kind;
  const reader = draft.read?.reader;
  if (!draft.document_sha256 || (kind !== "pdf" && kind !== "email" && kind !== "text") || !isReader(reader)) return null;
  const submitted: Submitted = {
    amount: invoice.amount,
    currency: invoice.currency,
    dueDate: invoice.dueDate,
    poReference: invoice.poReference,
    earlyPayDiscountPct: invoice.earlyPayDiscountPct,
    discountDeadline: invoice.discountDeadline,
    memo: invoice.memo,
    counterpartyId: invoice.counterpartyId,
  };
  return { kind, sha256: draft.document_sha256, reader, changed: changedFields(draft.read?.extracted ?? {}, submitted) };
}

/**
 * Adds a sent draft as a bill (C6, C7), as the person finished it in the invoice form: through `addInvoice`, so every
 * check of the form, the counterparty's screening and the agent's decision apply as to any bill. A draft that may
 * repeat a bill or another draft needs `notDuplicate`, checked again here with what the person chose. The draft is
 * used once: it moves from `sent` to `confirmed` in one guarded update, with the id the bill is added with. A refusal
 * that wrote nothing puts it back. Any other failure is looked up by that id: a bill that was added after all (its
 * ledger entry failed) stays added and linked, never added twice; one that was not puts the draft back; and when that
 * cannot be told, the draft stays confirmed for the daily cleanup to settle by the same id. Then its captured text is
 * removed (C9).
 */
export async function confirmInvoiceDraft(
  actor: Actor,
  input: { draftId: string; invoice: InvoiceInput; notDuplicate: boolean }
): Promise<CommandOutcome<{ invoiceId: string }>> {
  const refusal = gate(actor, "invoice_draft.confirm");
  if (refusal) return refusal;
  if (input.invoice.direction !== "payable") return refused("invalid", "A captured invoice is a bill to pay.");
  const draft = await draftById(input.draftId);
  if (!draft || draft.state !== "sent") return refused("not_found", ALREADY_DECIDED);

  if (!input.notDuplicate) {
    const [bills, others] = await Promise.all([billsOf([input.invoice.counterpartyId]), draft.invoice_number ? draftsNaming([draft.invoice_number]) : []]);
    const repeats = draftDuplicates(
      {
        id: draft.id,
        counterpartyId: input.invoice.counterpartyId,
        supplierName: draft.supplier_name,
        invoiceNumber: draft.invoice_number,
        amount: input.invoice.amount,
        currency: input.invoice.currency,
        dueDate: input.invoice.dueDate,
        memo: input.invoice.memo,
        poReference: input.invoice.poReference,
      },
      bills,
      others
    );
    if (repeats.length > 0) {
      return refused("possible_duplicate", `${repeats[0]} If it is not a duplicate, tick This is not a duplicate and add it again.`);
    }
  }

  const invoiceId = randomUUID();
  const claimed = await moveDraft(draft.id, "sent", {
    state: "confirmed",
    decided_by: actor.userId,
    decided_at: new Date().toISOString(),
    claimed_invoice_id: invoiceId,
  });
  if (!claimed) return refused("not_found", ALREADY_DECIDED);

  const added = await addInvoice(actor, {
    invoiceId,
    invoice: input.invoice,
    document: capturedProvenance(draft, input.invoice),
    captured: { invoiceDraftId: draft.id, invoiceNumber: draft.invoice_number },
  });
  if (added.ok) {
    await linkDraft(actor, draft.id, invoiceId, `Added an invoice captured with the Chrome extension as a bill for ${added.counterpartyName}`);
    return done(`Added a bill for ${added.counterpartyName}. The agent usually decides within a minute.`, { invoiceId });
  }
  if (!NOTHING_WRITTEN.has(added.code)) {
    let exists: boolean | null;
    try {
      exists = await invoiceExists(invoiceId);
    } catch (error) {
      console.error("a captured draft's bill could not be looked up", actor.orgId, error instanceof Error ? error.message : "unknown error");
      exists = null;
    }
    if (exists) {
      // The bill was added; what failed after it was its ledger entry. It is linked, and never added a second time.
      await linkDraft(actor, draft.id, invoiceId, "Added an invoice captured with the Chrome extension as a bill");
      runCycleSoon(cycleEventOf(actor, "invoice_added"));
      return done("The bill was added, but its ledger entry was not recorded. The agent decides it within a minute.", { invoiceId });
    }
    if (exists === null) {
      return refused(
        "failed",
        "We could not tell whether the bill was added. Look for it on Bills & receivables before adding it again: this draft comes back for review within a day if it was not added."
      );
    }
  }
  // Nothing was written: back for review, for someone to add once the reason is fixed, or to discard.
  await moveDraft(draft.id, "confirmed", { state: "sent", decided_by: null, decided_at: null, claimed_invoice_id: null }).catch((error: unknown) => {
    console.error("a captured draft was not put back", actor.orgId, error instanceof Error ? error.message : "unknown error");
  });
  return added;
}

/** Links a confirmed draft to its bill, removes its captured text (C9), and records `invoice_draft_confirmed`. */
async function linkDraft(actor: Actor, draftId: string, invoiceId: string, summary: string): Promise<void> {
  try {
    await moveDraft(draftId, "confirmed", { invoice_id: invoiceId, raw_text: null });
  } catch (error) {
    // The daily cleanup links it by `claimed_invoice_id`.
    console.error("a captured draft was added but not linked", actor.orgId, error instanceof Error ? error.message : "unknown error");
  }
  await appendLedgerEntryBestEffort(actor.orgId, {
    actor: "human",
    domain: "ap",
    action: "invoice_draft_confirmed",
    summary,
    detail: { by: actor.userId, draftId, invoiceId },
  });
}

/** Discards a draft not yet decided (C5, C8); its captured text goes with the decision (C9). */
export async function discardInvoiceDraft(actor: Actor, input: { draftId: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "invoice_draft.discard");
  if (refusal) return refusal;
  const discarded = await moveDraft(input.draftId, ["draft", "sent"], {
    state: "discarded",
    decided_by: actor.userId,
    decided_at: new Date().toISOString(),
    raw_text: null,
  });
  if (!discarded) return refused("not_found", ALREADY_DECIDED);
  await appendLedgerEntryBestEffort(actor.orgId, {
    actor: "human",
    domain: "ap",
    action: "invoice_draft_discarded",
    summary: "Discarded an invoice captured with the Chrome extension",
    detail: { by: actor.userId, draftId: discarded.id },
  });
  return done("Discarded.");
}
