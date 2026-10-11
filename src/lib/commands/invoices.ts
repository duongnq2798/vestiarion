import { runCycleSoon } from "../agent/cycle-soon";
import type { DocumentProvenance } from "../invoice-document/provenance";
import { createInvoice, type ImportedRow, type InvoiceInput } from "../invoices/create";
import type { OriginalBill } from "../shadow-bills";
import { cycleEventOf, type Actor } from "./actor";
import { done, refused, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * Adds an invoice as the actor (integrations design §9, Phase 0), through the one `createInvoice` the invoice form
 * uses. A payable gives the agent a decision to make, so it starts a cycle within seconds; a receivable does not. A
 * bill list's import adds each of its rows through it (import design B12); the invoice form and the write API move onto
 * it next.
 */
export async function addInvoice(
  actor: Actor,
  input: {
    invoice: InvoiceInput;
    document: DocumentProvenance | null;
    /** The inbox row it was read from, when it arrived by email (email invoices design E8). */
    received?: { inboxEmailId: string };
    /** The bill in the business's own currency, converted to USDC in shadow mode (shadow mode S6). */
    original?: OriginalBill;
    /** The bill list it was imported from, and its row there (import design B12). */
    imported?: ImportedRow;
  }
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
      // An invoice that arrived by email names the email, whoever added it and wherever from.
      ...(input.received ? { via: "email" as const, inboxEmailId: input.received.inboxEmailId } : {}),
      ...(input.original ? { original: input.original } : {}),
      // A row of a bill list a person imported, with the list's hash and its row (import design B12).
      ...(input.imported ? { via: "import" as const, imported: input.imported } : {}),
    });
  } catch (error) {
    console.error("adding an invoice failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", "The invoice could not be added. Try again in a moment.");
  }
  if (!created) return refused("counterparty_not_found", "Counterparty not found.");
  if (input.invoice.direction === "payable") runCycleSoon(cycleEventOf(actor, "invoice_added"));
  return done(`Invoice added for ${created.counterpartyName}.`, { invoiceId: created.id, counterpartyName: created.counterpartyName });
}
