import type { NewKind } from "@/lib/bills-view";

/**
 * New ▾'s items on Bills & receivables (docs/superpowers/specs/2026-10-12-bills-tabs-design.md B13), in the menu's order:
 * what each says, and the title and line of the sheet it opens. Plain data, so the server's pages (the guides' pictures)
 * read the same words as the menu.
 */
export const NEW_ITEMS: ReadonlyArray<{ kind: NewKind; label: string; title: string; description: string; wide?: boolean }> = [
  { kind: "bill", label: "Bill to pay", title: "New bill to pay", description: "Typed in. The agent decides it at its next cycle." },
  { kind: "invoice", label: "Invoice to a customer", title: "New invoice to a customer", description: "A receivable: money a customer owes you." },
  { kind: "document", label: "From a document", title: "New invoice from a document", description: "The model reads a PDF or an email into the form; nothing is added until you check it.", wide: true },
  { kind: "import", label: "Import a list", title: "Import a list of bills", description: "A CSV or a spreadsheet's rows, checked before anything is added.", wide: true },
  { kind: "recurring", label: "Recurring", title: "New recurring payment", description: "Each period's bill is created as it comes near, and decided like any other." },
  { kind: "deal", label: "Deal", title: "New deal", description: "A signed deal and its collection schedule: a deposit, milestones, a retainer or your own lines." },
];

/** New ▾'s items for this workspace: Deal only where deals are set up. */
export function newItemsFor(deal: unknown): typeof NEW_ITEMS {
  return NEW_ITEMS.filter((entry) => entry.kind !== "deal" || deal !== null);
}
