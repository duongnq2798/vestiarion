import { checkBillList } from "../bill-import/check";
import { baseOf, type ImportedFate } from "../bill-import/rows";
import { plural } from "../copy";
import type { Actor } from "./actor";
import { addInvoice } from "./invoices";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/** What an import did, row by row and in all. */
export interface ImportOutcome {
  fates: ImportedFate[];
  counts: { added: number; duplicate: number; error: number };
}

/** The import's result in words: "Added 84 bills. 3 were already in Vestiarion. 13 can't be added." */
export function importMessage(counts: ImportOutcome["counts"]): string {
  const parts = [counts.added === 0 ? "Added no bills." : `Added ${counts.added} ${plural(counts.added, "bill", "bills")}.`];
  if (counts.duplicate > 0) parts.push(`${counts.duplicate} ${plural(counts.duplicate, "was", "were")} already in Vestiarion.`);
  if (counts.error > 0) parts.push(`${counts.error} can't be added.`);
  return parts.join(" ");
}

/**
 * Imports a bill list as the actor (import design B12). The list is read and checked again exactly as the check read
 * it, then each row to add goes through `addInvoice`, one after another: the same gate, the same insert, the same signed
 * `create_invoice` entry, naming the list by its hash and the row. A row the command refuses says why; the others are
 * still added. A row already in the workspace is never added again, so importing the same list twice adds it once.
 */
export async function importInvoices(actor: Actor, input: { text: string; settings: unknown }): Promise<CommandOutcome<ImportOutcome>> {
  const refusal = gate(actor, "invoice.import");
  if (refusal) return refusal;
  let checked: Awaited<ReturnType<typeof checkBillList>>;
  try {
    checked = await checkBillList(input.text, input.settings);
  } catch (error) {
    console.error("checking a bill list failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
  if (!checked.ok) return refused("unreadable", checked.message);

  const fates: ImportedFate[] = [];
  for (const fate of checked.fates) {
    if (fate.status !== "add") {
      fates.push(fate);
      continue;
    }
    const added = await addInvoice(actor, {
      invoice: fate.invoice,
      document: null,
      ...(fate.original ? { original: fate.original } : {}),
      imported: { file: checked.file, row: fate.line, invoiceNumber: fate.invoiceNumber },
    });
    fates.push(added.ok ? { ...baseOf(fate), status: "added", invoiceId: added.invoiceId } : { ...baseOf(fate), status: "error", reason: added.message });
  }
  const counts = {
    added: fates.filter((fate) => fate.status === "added").length,
    duplicate: fates.filter((fate) => fate.status === "duplicate").length,
    error: fates.filter((fate) => fate.status === "error").length,
  };
  return done(importMessage(counts), { fates, counts });
}
