import { checkBillList } from "../bill-import/check";
import { baseOf, countImported, importMessage, type ImportCounts, type ImportedFate } from "../bill-import/rows";
import type { Actor } from "./actor";
import { addInvoice } from "./invoices";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/** What an import did, row by row and in all. */
export interface ImportOutcome {
  fates: ImportedFate[];
  counts: ImportCounts;
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
  const counts = countImported(fates);
  return done(importMessage(counts), { fates, counts });
}
