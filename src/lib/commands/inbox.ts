import { db, unwrap } from "../dal";
import type { ShownRead } from "../email-inbox/list";
import { invoiceOfDraft, type StoredChatDraft } from "../invoice-document/chat-draft";
import { changedFields, isReader, type DocumentProvenance, type Submitted } from "../invoice-document/provenance";
import type { InvoiceInput } from "../invoices/create";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import type { Actor } from "./actor";
import { addInvoice } from "./invoices";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * A person's decision on an invoice that arrived by email (email invoices design E7, E8): added as a payable, or
 * dismissed. Adding is a records write, an owner's or admin's, as adding any invoice is. The draft is used once: its
 * row moves from `ready` to `added` in one guarded update before anything is written, and is put back if the invoice
 * could not be added after all. Runs inside the workspace's scope.
 */

const STILL_TO_DECIDE = ["received", "ready", "needs_details", "unreadable"];

export async function addFromInbox(
  actor: Actor,
  input: { inboxEmailId: string; goodsReceived: boolean }
): Promise<CommandOutcome<{ invoiceId: string }>> {
  const refusal = gate(actor, "inbox.add");
  if (refusal) return refusal;
  let stored: StoredChatDraft | null;
  try {
    const rows = unwrap(
      await db()
        .from("inbox_emails")
        .update({ status: "added", decided_by: actor.userId, decided_at: new Date().toISOString() })
        .eq("id", input.inboxEmailId)
        .eq("status", "ready")
        .select("draft")
    ) as Array<{ draft: StoredChatDraft | null }>;
    stored = rows[0]?.draft ?? null;
  } catch (error) {
    console.error("adding an emailed invoice failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
  if (!stored) return refused("not_ready", "This email was already decided, or cannot be added as it was read.");

  const invoice = invoiceOfDraft(stored, input.goodsReceived);
  const added = invoice ? await addInvoice(actor, { invoice, document: { ...stored.document, changed: [] }, received: { inboxEmailId: input.inboxEmailId } }) : null;
  if (!invoice || !added?.ok) {
    // Put it back, for someone to add once the reason is fixed, or to dismiss.
    await db().from("inbox_emails").update({ status: "ready", decided_by: null, decided_at: null }).eq("id", input.inboxEmailId).eq("status", "added");
    return added && !added.ok
      ? added
      : refused("invalid", "The invoice as it was read is no longer valid. Add it on Bills & receivables instead.");
  }
  const linked = await db().from("inbox_emails").update({ invoice_id: added.invoiceId }).eq("id", input.inboxEmailId);
  if (linked.error) console.error("an emailed invoice was added but not linked", actor.orgId, linked.error.message);
  return done(`Added a payable for ${added.counterpartyName}. The agent usually decides within a minute.`, { invoiceId: added.invoiceId });
}

/** An email a person can finish by hand: read and ready, read with a detail missing, or not read at all. */
const FINISHABLE = ["ready", "needs_details", "unreadable"];

interface FinishableRow {
  status: string;
  read: ShownRead | null;
  draft: StoredChatDraft | null;
}

/**
 * What the entry of an invoice finished by hand says of its document (reader follow-up F5): the kind, hash and reader
 * the inbox stored, and the fields the person changed. A ready email is compared with its stored draft, the form it
 * would have been added as; another with what the inbox read. An email that was never read names no document.
 */
function finishedProvenance(row: FinishableRow, invoice: InvoiceInput): DocumentProvenance | null {
  const source = row.read?.document ? { ...row.read.document, reader: row.read.reader } : row.draft?.document;
  if (!source || !isReader(source.reader)) return null;
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
  return { kind: source.kind, sha256: source.sha256, reader: source.reader, changed: changedFields(row.draft?.draft ?? row.read ?? {}, submitted) };
}

/**
 * Adds an emailed invoice as a person finished it on Bills & receivables (reader follow-up F5): each field as they kept
 * or typed it, from an email that is ready, lacks a detail, or could not be read; `inbox.finish` needs what `inbox.add`
 * does. The email is used once: it moves from the status it had to `added` in one guarded update, and back if the
 * invoice could not be added after all. The entry names the email, and the document with the fields the person changed.
 */
export async function finishFromInbox(
  actor: Actor,
  input: { inboxEmailId: string; invoice: InvoiceInput }
): Promise<CommandOutcome<{ invoiceId: string }>> {
  const refusal = gate(actor, "inbox.finish");
  if (refusal) return refusal;
  if (input.invoice.direction !== "payable") return refused("invalid", "An invoice that arrives by email is a payable.");
  let row: FinishableRow | null;
  try {
    const found = await db().from("inbox_emails").select("status, read, draft").eq("id", input.inboxEmailId).maybeSingle<FinishableRow>();
    if (found.error) throw new Error(found.error.message);
    row = found.data && FINISHABLE.includes(found.data.status) ? found.data : null;
    if (row) {
      const claimed = unwrap(
        await db()
          .from("inbox_emails")
          .update({ status: "added", decided_by: actor.userId, decided_at: new Date().toISOString() })
          .eq("id", input.inboxEmailId)
          .eq("status", row.status)
          .select("id")
      ) as Array<{ id: string }>;
      if (claimed.length === 0) row = null;
    }
  } catch (error) {
    console.error("finishing an emailed invoice failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
  if (!row) return refused("not_found", "This email was already decided.");

  const added = await addInvoice(actor, { invoice: input.invoice, document: finishedProvenance(row, input.invoice), received: { inboxEmailId: input.inboxEmailId } });
  if (!added.ok) {
    // Put it back as it was, for someone to finish once the reason is fixed, or to dismiss.
    await db().from("inbox_emails").update({ status: row.status, decided_by: null, decided_at: null }).eq("id", input.inboxEmailId).eq("status", "added");
    return added;
  }
  const linked = await db().from("inbox_emails").update({ invoice_id: added.invoiceId }).eq("id", input.inboxEmailId);
  if (linked.error) console.error("an emailed invoice was added but not linked", actor.orgId, linked.error.message);
  return done(`Added a payable for ${added.counterpartyName}. The agent usually decides within a minute.`, { invoiceId: added.invoiceId });
}

export async function dismissFromInbox(actor: Actor, input: { inboxEmailId: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "inbox.dismiss");
  if (refusal) return refusal;
  try {
    const rows = unwrap(
      await db()
        .from("inbox_emails")
        .update({ status: "dismissed", decided_by: actor.userId, decided_at: new Date().toISOString() })
        .eq("id", input.inboxEmailId)
        .in("status", STILL_TO_DECIDE)
        .select("id")
    ) as Array<{ id: string }>;
    if (rows.length === 0) return refused("not_found", "This email was already decided.");
  } catch (error) {
    console.error("dismissing an emailed invoice failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
  await appendLedgerEntryBestEffort(actor.orgId, {
    actor: "human",
    domain: "ap",
    action: "invoice_email_dismissed",
    summary: "Dismissed an email that arrived at the invoice address",
    detail: { by: actor.userId, inboxEmailId: input.inboxEmailId },
  });
  return done("Dismissed.");
}
