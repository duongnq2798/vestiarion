import { runCycleSoon } from "../agent/cycle-soon";
import type { DocumentProvenance } from "../invoice-document/provenance";
import { createInvoice, type InvoiceInput } from "../invoices/create";
import { cycleEventOf, type Actor } from "./actor";
import { done, refused, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * Adds an invoice as the actor (integrations design §9, Phase 0), through the one `createInvoice` the invoice form
 * uses. A payable gives the agent a decision to make, so it starts a cycle within seconds; a receivable does not. The
 * invoice form, the CSV import and the write API move onto this command once the write API's branch, which changes
 * `createInvoice`, has merged.
 */
export async function addInvoice(
  actor: Actor,
  input: { invoice: InvoiceInput; document: DocumentProvenance | null }
): Promise<CommandOutcome<{ invoiceId: string; counterpartyName: string }>> {
  const refusal = gate(actor, "invoice.add");
  if (refusal) return refusal;
  let created: Awaited<ReturnType<typeof createInvoice>>;
  try {
    created = await createInvoice({
      actorId: actor.userId,
      invoice: input.invoice,
      document: input.document,
      // The entry names the bot exactly as it always has (Telegram bot design R10); Slack's names its link too (S15).
      ...(actor.surface.kind === "telegram" ? { via: "telegram" as const } : {}),
      ...(actor.surface.kind === "slack" ? { via: "slack" as const, linkId: actor.surface.linkId } : {}),
    });
  } catch (error) {
    console.error("adding an invoice failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", "The invoice could not be added. Try again in a moment.");
  }
  if (!created) return refused("counterparty_not_found", "Counterparty not found.");
  if (input.invoice.direction === "payable") runCycleSoon(cycleEventOf(actor, "invoice_added"));
  return done(`Invoice added for ${created.counterpartyName}.`, { invoiceId: created.id, counterpartyName: created.counterpartyName });
}
