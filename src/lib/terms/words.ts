/**
 * What a supplier reads of a request for more time (docs/superpowers/specs/2026-10-17-term-requests-design.md X4). Pure
 * and browser-safe.
 */

const money = (value: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Pinecrest Studio asks to pay invoice INV-108 on Nov 13, 2026 instead of Oct 30, 2026: 14 more days, for the full 1,000.00 USDC." */
export function termRequestLine(input: { orgName: string; reference: string | null; amount: number; currency: string; dueDate: string; newDueDate: string; days: number }): string {
  const bill = input.reference ? `invoice ${input.reference}` : "your invoice";
  return `${input.orgName} asks to pay ${bill} on ${day(input.newDueDate)} instead of ${day(input.dueDate)}: ${input.days} more ${input.days === 1 ? "day" : "days"}, for the full ${money(input.amount)} ${input.currency}.`;
}
