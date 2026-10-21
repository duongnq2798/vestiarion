/**
 * The rules of the invoice pay-to hold that touch no database
 * (docs/superpowers/specs/2026-10-21-invoice-pay-to-hold-design.md IP2, IP3), so the browser's approval card imports them
 * without the server's modules; ./invoice-pay-to reads what the invoices' documents asked for.
 */

/** Whether the invoice's document asked for an address that is not the one on file, case ignored. */
export function payToDiffers(documentPayTo: string | null | undefined, onFile: string | null | undefined): boolean {
  if (!documentPayTo) return false;
  return !onFile || documentPayTo.toLowerCase() !== onFile.toLowerCase();
}

/** What the approval card says when the invoice asked to be paid to another address (IP3). */
export function invoiceAskedFor(documentPayTo: string): string {
  return `The invoice asks to be paid to ${documentPayTo}. Approve and pay sends to the address above, the one on file. Check with the vendor, by a contact you had before, which address is theirs.`;
}
